const state = {
  library: null,
  people: [],
  selectedPersonId: null,
  selectedPerson: null,
  works: [],
  activeView: "people",
  personQuery: "",
  workQuery: "",
  sortMode: "title",
  filterMode: "all",
  currentWork: null,
  currentVideo: null,
  progressTimer: null,
  lastProgressReport: 0,
  searchReturnView: "people",
  searchTimer: null,
  searchSeq: 0,
  searchPeople: []
};

const els = {
  librarySummary: document.querySelector("#librarySummary"),
  rescanButton: document.querySelector("#rescanButton"),
  personSearch: document.querySelector("#personSearch"),
  personList: document.querySelector("#personList"),
  viewTabs: [...document.querySelectorAll(".view-tab")],
  workSearch: document.querySelector("#workSearch"),
  sortSelect: document.querySelector("#sortSelect"),
  filterSelect: document.querySelector("#filterSelect"),
  personProfile: document.querySelector("#personProfile"),
  currentPath: document.querySelector("#currentPath"),
  currentTitle: document.querySelector("#currentTitle"),
  statsRow: document.querySelector("#statsRow"),
  workGrid: document.querySelector("#workGrid"),
  drawerBackdrop: document.querySelector("#drawerBackdrop"),
  detailDrawer: document.querySelector("#detailDrawer"),
  closeDrawer: document.querySelector("#closeDrawer"),
  drawerPath: document.querySelector("#drawerPath"),
  drawerTitle: document.querySelector("#drawerTitle"),
  playerArea: document.querySelector("#playerArea"),
  metaArea: document.querySelector("#metaArea"),
  infoArea: document.querySelector("#infoArea"),
  placeholderTemplate: document.querySelector("#placeholderTemplate")
};

const formatter = new Intl.NumberFormat("zh-CN");

function formatNumber(value) {
  return formatter.format(value || 0);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function includesText(value, query) {
  return String(value || "").toLowerCase().includes(query.trim().toLowerCase());
}

function coverUrl(coverId) {
  return coverId ? `/media/image/${encodeURIComponent(coverId)}` : "";
}

function workCoverUrl(work) {
  return coverUrl(work.coverId) || work.cachedCover?.coverUrl || "";
}

function formatLibraryPath(value) {
  if (!value) return "";
  const normalized = String(value).replaceAll("/", "\\");
  return /^[A-Za-z]:\\?/.test(normalized) ? normalized : `G:\\${normalized}`;
}

function formatLibraryPaths(values) {
  const paths = (values || []).filter(Boolean).map(formatLibraryPath);
  return paths.length ? paths.join(" · ") : "G:\\ / F:\\ / O:\\ / V:\\";
}

async function api(path, options = {}) {
  const init = { ...options };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  }

  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `请求失败：${response.status}`);
  }
  return payload;
}

async function loadLibrary() {
  els.librarySummary.textContent = "正在读取索引";
  const data = await api("/api/library");
  state.library = data;
  state.people = sortPeopleForList(data.people || []);

  if (state.selectedPersonId && !state.people.some((person) => person.id === state.selectedPersonId)) {
    state.selectedPersonId = null;
  }

  renderPeople();
  renderSummary();
  setActiveView(state.activeView || "people");
}

function normalizeSourcePath(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function sourcePriority(value) {
  const sourcePath = normalizeSourcePath(value);
  if (sourcePath.startsWith("g:/")) return 0;
  if (sourcePath.startsWith("f:/")) return 1;
  if (sourcePath === "o:/[珍藏]" || sourcePath.startsWith("o:/[珍藏]/")) return 2;
  if (sourcePath === "o:/[珍藏1]" || sourcePath.startsWith("o:/[珍藏1]/")) return 3;
  if (sourcePath.startsWith("o:/")) return 4;
  if (sourcePath === "v:/[a]" || sourcePath.startsWith("v:/[a]/")) return 5;
  if (sourcePath === "v:/[a1]" || sourcePath.startsWith("v:/[a1]/")) return 6;
  if (sourcePath === "v:/av" || sourcePath.startsWith("v:/av/")) return 7;
  if (sourcePath.startsWith("v:/")) return 8;
  return 9;
}

function personSourcePriority(person) {
  const paths = [...(person.sourcePaths || []), person.relativePath].filter(Boolean);
  if (!paths.length) return 9;
  return Math.min(...paths.map(sourcePriority));
}

function sortPeopleForList(people) {
  return [...people].sort((a, b) => {
    const priority = personSourcePriority(a) - personSourcePriority(b);
    if (priority) return priority;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function renderSummary() {
  const totals = state.library?.totals || {};
  const rootCount = state.library?.availableRoots?.length || 0;
  const favoriteCount = state.library?.user?.favoriteCount || 0;
  els.librarySummary.textContent = `${formatNumber(rootCount)} 盘 · ${formatNumber(totals.people)} 人 · ${formatNumber(totals.videos)} 视频 · ${formatNumber(favoriteCount)} 收藏`;
}

function setActiveView(view) {
  state.activeView = view;
  if (view !== "search") state.searchPeople = [];
  els.viewTabs.forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  renderPeople();

  if (view === "favorites") {
    loadFavorites();
    return;
  }

  if (view === "history") {
    loadHistory();
    return;
  }

  showPeopleIndex();
}

function filteredPeople() {
  return state.people.filter((person) => includesText(person.name, state.personQuery));
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

  for (const person of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `person-button${person.id === state.selectedPersonId && state.activeView === "people" ? " active" : ""}`;
    button.addEventListener("click", () => {
      clearWorkSearch();
      state.activeView = "people";
      selectPerson(person.id);
    });

    const name = document.createElement("span");
    name.className = "person-name";
    name.textContent = person.name;

    const count = document.createElement("span");
    count.className = "person-count";
    count.textContent =
      person.sourceCount > 1 ? `${formatNumber(person.workCount)} 部 · ${person.sourceCount} 处` : `${formatNumber(person.workCount)} 部`;

    button.append(name, count);
    els.personList.append(button);
  }
}

function showPeopleIndex() {
  state.activeView = "people";
  state.selectedPersonId = null;
  state.selectedPerson = null;
  state.searchPeople = [];
  state.works = [];
  els.viewTabs.forEach((button) => button.classList.toggle("active", button.dataset.view === "people"));
  renderPeople();
  hidePersonProfile();
  setMainHeader("人物索引", "按人物浏览全部资料库");
  renderPeopleIndexStats();
  renderPeopleIndex();
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
  const people = filteredPeople();
  els.workGrid.innerHTML = "";

  if (!people.length) {
    appendEmpty("没有匹配的人物。");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const person of people) {
    fragment.append(createPersonIndexCard(person));
  }
  els.workGrid.append(fragment);
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
  if (person.infoCount > 0) metrics.append(createInfoChip(`${formatNumber(person.infoCount)} 资料`));
  if ((person.sourceCount || 0) > 1) metrics.append(createInfoChip(`${formatNumber(person.sourceCount)} 处`));

  body.append(name, sub, metrics);
  card.append(avatar, body);
  return card;
}

async function selectPerson(personId) {
  state.selectedPersonId = personId;
  state.activeView = "people";
  state.searchPeople = [];
  els.viewTabs.forEach((button) => button.classList.toggle("active", button.dataset.view === "people"));
  renderPeople();
  els.workGrid.innerHTML = `<div class="empty-state">正在加载作品</div>`;

  const data = await api(`/api/people/${encodeURIComponent(personId)}`);
  state.selectedPerson = data.person;
  state.works = data.works || [];
  setMainHeader(state.selectedPerson.name, formatLibraryPaths(state.selectedPerson.sourcePaths || [state.selectedPerson.relativePath]));
  renderPersonProfile(state.selectedPerson);
  renderStatsForWorks(state.works, state.selectedPerson);
  renderWorks();
}

async function goToPerson(personId) {
  if (!personId) return;
  if (els.detailDrawer.classList.contains("open")) {
    closeDrawer();
  }
  clearWorkSearch();
  await selectPerson(personId);
}

async function loadFavorites() {
  els.workGrid.innerHTML = `<div class="empty-state">正在加载收藏</div>`;
  const data = await api("/api/favorites");
  state.selectedPerson = null;
  state.searchPeople = [];
  hidePersonProfile();
  state.works = data.works || [];
  setMainHeader("收藏", "已收藏的作品");
  renderStatsForWorks(state.works);
  renderWorks("还没有收藏。");
}

async function loadHistory() {
  els.workGrid.innerHTML = `<div class="empty-state">正在加载观看记录</div>`;
  const data = await api("/api/history");
  state.selectedPerson = null;
  state.searchPeople = [];
  hidePersonProfile();
  state.works = data.works || [];
  setMainHeader("继续观看", "有播放进度的作品");
  renderStatsForWorks(state.works);
  renderWorks("暂无观看记录。");
}

function setMainHeader(title, pathText) {
  els.currentTitle.textContent = title;
  els.currentPath.textContent = pathText;
}

function hidePersonProfile() {
  if (!els.personProfile) return;
  els.personProfile.hidden = true;
  els.personProfile.innerHTML = "";
}

function renderPersonProfile(person) {
  if (!els.personProfile || !person) return;

  const profile = person.actorProfile || null;
  const avatarUrl = profile?.avatarUrl || coverUrl(person.coverId);
  const displayName = profile?.displayName || person.name;
  const aliases = profile?.aliases || [];

  els.personProfile.hidden = false;
  els.personProfile.innerHTML = "";

  const avatar = document.createElement("div");
  avatar.className = "person-avatar";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = avatarUrl;
    img.addEventListener("error", () => {
      img.remove();
      avatar.textContent = person.name.slice(0, 2);
      avatar.classList.add("empty");
    });
    avatar.append(img);
  } else {
    avatar.classList.add("empty");
    avatar.textContent = person.name.slice(0, 2);
  }

  const copy = document.createElement("div");
  copy.className = "person-profile-copy";

  const nameRow = document.createElement("div");
  nameRow.className = "person-profile-name-row";

  const title = document.createElement("h3");
  title.textContent = displayName;
  nameRow.append(title);

  if (profile?.javdbUrl) {
    const link = document.createElement("a");
    link.className = "person-profile-link";
    link.href = profile.javdbUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.title = "打开外部资料页";
    link.textContent = "资料页";
    nameRow.append(link);
  }

  const sub = document.createElement("div");
  sub.className = "person-profile-sub";
  sub.textContent = aliases.length ? aliases.join("、") : formatLibraryPaths(person.sourcePaths || [person.relativePath]);

  const metrics = document.createElement("div");
  metrics.className = "person-profile-metrics";
  metrics.append(
    createProfileMetric("作品", person.workCount),
    createProfileMetric("视频", person.videoCount),
    createProfileMetric("可播", person.playableCount),
    createProfileMetric("资料", person.infoCount),
    createProfileMetric("来源", person.sourceCount)
  );

  copy.append(nameRow, sub, metrics);
  els.personProfile.append(avatar, copy);
}

function createProfileMetric(label, value) {
  const item = document.createElement("span");
  item.innerHTML = `<strong></strong><small></small>`;
  item.querySelector("strong").textContent = formatNumber(value);
  item.querySelector("small").textContent = label;
  return item;
}

function renderStatsForWorks(works, person = null) {
  const stats = person
    ? [
        ["作品", person.workCount],
        ["视频", person.videoCount],
        ["可网页播放", person.playableCount],
        ["资料文件", person.infoCount]
      ]
    : [
        ["作品", works.length],
        ["视频", works.reduce((sum, work) => sum + work.videoCount, 0)],
        ["可网页播放", works.reduce((sum, work) => sum + work.playableCount, 0)],
        ["有进度", works.filter((work) => work.progress).length]
      ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    const stat = document.createElement("div");
    stat.className = "stat";
    stat.innerHTML = `<strong>${formatNumber(value)}</strong><span>${label}</span>`;
    els.statsRow.append(stat);
  }
}

function visibleWorks() {
  const query = state.activeView === "search" ? "" : state.workQuery.trim().toLowerCase();
  let works = state.works.filter((work) => {
    if (!query) return true;
    return includesText(work.title, query) || includesText(work.relativePath, query) || includesText(work.personName, query);
  });

  works = works.filter((work) => {
    if (state.filterMode === "playable") return work.playableCount > 0;
    if (state.filterMode === "favorite") return work.favorite;
    if (state.filterMode === "progress") return Boolean(work.progress);
    if (state.filterMode === "info") return work.infoCount > 0;
    if (state.filterMode === "missingCover") return !workCoverUrl(work);
    return true;
  });

  works.sort((a, b) => {
    if (state.sortMode === "updated") return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
    if (state.sortMode === "progress") return String(b.progress?.updatedAt || "").localeCompare(String(a.progress?.updatedAt || ""));
    if (state.sortMode === "videos") return b.videoCount - a.videoCount || a.title.localeCompare(b.title, undefined, { numeric: true });
    return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  });

  return works;
}

function clearWorkSearch() {
  state.workQuery = "";
  els.workSearch.value = "";
}

async function loadSearchResults(query) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    state.searchPeople = [];
    if (state.activeView === "search") {
      setActiveView(state.searchReturnView || "people");
    } else {
      renderWorks();
    }
    return;
  }

  if (state.activeView !== "search") {
    state.searchReturnView = state.activeView || "people";
  }

  state.activeView = "search";
  els.viewTabs.forEach((button) => button.classList.remove("active"));
  renderPeople();
  hidePersonProfile();
  setMainHeader(`搜索：${normalizedQuery}`, "全库 · 番号 / 标题 / 文件名 / 人物");
  els.statsRow.innerHTML = "";
  els.workGrid.innerHTML = `<div class="empty-state">正在全库搜索</div>`;

  const seq = ++state.searchSeq;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(normalizedQuery)}`);
    if (seq !== state.searchSeq) return;
    state.selectedPerson = null;
    state.searchPeople = data.people || [];
    state.works = data.works || [];
    renderStatsForWorks(state.works);
    renderWorks(`没有搜到「${normalizedQuery}」。`);
  } catch (error) {
    if (seq !== state.searchSeq) return;
    renderEmpty(error.message);
  }
}

function renderWorks(emptyMessage = "没有匹配的作品。") {
  const works = visibleWorks();
  els.workGrid.innerHTML = "";
  renderSearchPeoplePanel();

  if (!works.length) {
    appendEmpty(emptyMessage);
    return;
  }

  for (const work of works) {
    els.workGrid.append(createWorkCard(work));
  }
}

function renderEmpty(message) {
  els.workGrid.innerHTML = "";
  appendEmpty(message);
}

function appendEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  els.workGrid.append(empty);
}

function renderSearchPeoplePanel() {
  if (state.activeView !== "search" || !state.searchPeople.length) return;

  const panel = document.createElement("div");
  panel.className = "search-people-panel";

  const label = document.createElement("div");
  label.className = "search-people-title";
  label.textContent = "人物命中";
  panel.append(label);

  const list = document.createElement("div");
  list.className = "search-people-list";

  for (const person of state.searchPeople) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-person-chip";
    button.textContent = `${person.name} · ${formatNumber(person.workCount)} 部`;
    button.addEventListener("click", () => {
      goToPerson(person.id);
    });
    list.append(button);
  }

  panel.append(list);
  els.workGrid.append(panel);
}

function createWorkCard(work) {
  const card = document.createElement("article");
  card.className = "work-card";
  card.dataset.workId = work.id;

  const cover = document.createElement("div");
  cover.className = "cover-wrap";
  cover.addEventListener("click", () => openWork(work.id));

  const resolvedCoverUrl = workCoverUrl(work);
  if (resolvedCoverUrl) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = resolvedCoverUrl;
    img.addEventListener("error", () => {
      img.replaceWith(els.placeholderTemplate.content.cloneNode(true));
    });
    cover.append(img);
  } else {
    cover.append(els.placeholderTemplate.content.cloneNode(true));
  }

  const favorite = document.createElement("button");
  favorite.type = "button";
  favorite.className = `favorite-button${work.favorite ? " active" : ""}`;
  favorite.title = work.favorite ? "取消收藏" : "收藏";
  favorite.textContent = "★";
  favorite.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFavorite(work.id);
  });
  cover.append(favorite);

  if (work.progress?.percent) {
    const track = document.createElement("div");
    track.className = "progress-track";
    track.innerHTML = `<div class="progress-fill" style="width:${Math.min(100, Math.max(0, work.progress.percent)).toFixed(1)}%"></div>`;
    cover.append(track);
  }

  const body = document.createElement("div");
  body.className = "work-body";
  body.addEventListener("click", () => openWork(work.id));

  const title = document.createElement("div");
  title.className = "work-title";
  title.textContent = work.title;

  const info = document.createElement("div");
  info.className = "work-card-info";
  const code = extractWorkCode(work);
  if (code) info.append(createInfoChip(code, "code"));
  const source = workSourceLabel(work);
  if (source.label) info.append(createInfoChip(source.label, source.vr ? "vr" : ""));
  if (work.playableCount > 0) info.append(createInfoChip(`${formatNumber(work.playableCount)} 可播`));
  if (work.playableCount === 0) info.append(createInfoChip("暂不支持", "warning"));
  if (work.videoCount > 1) info.append(createInfoChip(`${formatNumber(work.videoCount)} 段`));
  if (work.infoCount > 0) info.append(createInfoChip(`${formatNumber(work.infoCount)} 资料`));

  const meta = document.createElement("div");
  meta.className = "work-meta";
  if (state.activeView !== "people" && work.personName) {
    meta.append(createPersonLink(work.personName, work.personId));
  }
  meta.append(createMetaPart(`${formatNumber(work.videoCount)} 视频`), createMetaPart(`${formatNumber(work.imageCount)} 图片`));
  if (work.progress?.percent) meta.append(createMetaPart(`看到 ${Math.floor(work.progress.percent)}%`));

  body.append(title, info, meta);
  card.append(cover, body);
  return card;
}

function extractWorkCode(work) {
  const text = `${work.directoryName || ""} ${work.title || ""}`;
  const match = text.match(/(?:\[[^\]]+\][._\s-]*)?([a-z]{2,10})[-_\s]?(\d{2,6})/i);
  if (!match) return "";
  return `${match[1].toUpperCase()}-${match[2]}`;
}

function workSourceLabel(work) {
  const sourcePath = normalizeSourcePath(work.relativePath);
  if (sourcePath === "v:/[a]" || sourcePath.startsWith("v:/[a]/")) return { label: "VR · V:[A]", vr: true };
  if (sourcePath === "v:/[a1]" || sourcePath.startsWith("v:/[a1]/")) return { label: "VR · V:[A1]", vr: true };
  if (sourcePath === "v:/av" || sourcePath.startsWith("v:/av/")) return { label: "VR · V:AV", vr: true };
  if (sourcePath === "o:/[珍藏]" || sourcePath.startsWith("o:/[珍藏]/")) return { label: "O:珍藏", vr: false };
  if (sourcePath === "o:/[珍藏1]" || sourcePath.startsWith("o:/[珍藏1]/")) return { label: "O:珍藏1", vr: false };
  if (sourcePath.startsWith("g:/")) return { label: "G:", vr: false };
  if (sourcePath.startsWith("f:/")) return { label: "F:", vr: false };
  if (sourcePath.startsWith("o:/")) return { label: "O:", vr: false };
  return { label: "", vr: false };
}

function createInfoChip(text, variant = "") {
  const chip = document.createElement("span");
  chip.className = `info-chip${variant ? ` ${variant}` : ""}`;
  chip.textContent = text;
  return chip;
}

function createMetaPart(text) {
  const span = document.createElement("span");
  span.className = "meta-part";
  span.textContent = text;
  return span;
}

function createPersonLink(name, personId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "meta-person-link";
  button.textContent = name;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    goToPerson(personId);
  });
  return button;
}

function createBadge(text, variant = "") {
  const badge = document.createElement("span");
  badge.className = `badge${variant ? ` ${variant}` : ""}`;
  badge.textContent = text;
  return badge;
}

async function openWork(workId, videoId = null) {
  const data = await api(`/api/works/${encodeURIComponent(workId)}`);
  const work = data.work;
  state.currentWork = work;

  els.drawerTitle.textContent = work.title;
  els.drawerPath.textContent = formatLibraryPath(work.relativePath);
  renderPlayer(work, videoId);
  renderMeta(work);
  renderInfo(work);

  els.drawerBackdrop.hidden = false;
  els.detailDrawer.classList.add("open");
  els.detailDrawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function closeDrawer() {
  reportCurrentProgress();
  stopProgressReporting();
  els.detailDrawer.classList.remove("open");
  els.detailDrawer.setAttribute("aria-hidden", "true");
  els.drawerBackdrop.hidden = true;
  document.body.style.overflow = "";
  els.playerArea.innerHTML = "";
  state.currentWork = null;
  state.currentVideo = null;
}

function renderPlayer(work, requestedVideoId = null) {
  stopProgressReporting();
  els.playerArea.innerHTML = "";

  const actions = document.createElement("div");
  actions.className = "player-actions";

  const favoriteButton = document.createElement("button");
  favoriteButton.type = "button";
  favoriteButton.className = `text-button${work.favorite ? " active" : ""}`;
  favoriteButton.textContent = work.favorite ? "★ 已收藏" : "☆ 收藏";
  favoriteButton.addEventListener("click", () => toggleFavorite(work.id));
  actions.append(favoriteButton);
  els.playerArea.append(actions);

  const playableVideos = work.videos.filter((video) => video.playable);
  if (!playableVideos.length) {
    const unsupported = document.createElement("div");
    unsupported.className = "unsupported";
    unsupported.textContent = "这个作品的文件格式暂不支持网页播放。";
    els.playerArea.append(unsupported);
    return;
  }

  const progressVideoId = work.progress?.videoId;
  const selected =
    playableVideos.find((video) => video.id === requestedVideoId) ||
    playableVideos.find((video) => video.id === progressVideoId) ||
    playableVideos[0];
  state.currentVideo = selected;

  const video = document.createElement("video");
  video.className = "video-player";
  video.controls = true;
  video.preload = "metadata";
  video.src = `/media/video/${encodeURIComponent(selected.id)}`;

  const savedProgress = selected.progress || (work.progress?.videoId === selected.id ? work.progress : null);
  if (savedProgress?.position > 5) {
    video.addEventListener(
      "loadedmetadata",
      () => {
        if (savedProgress.position < video.duration - 8) {
          video.currentTime = savedProgress.position;
        }
      },
      { once: true }
    );
  }

  video.addEventListener("pause", reportCurrentProgress);
  video.addEventListener("ended", reportCurrentProgress);
  els.playerArea.append(video);
  startProgressReporting();
}

function renderMeta(work) {
  els.metaArea.innerHTML = "";

  if (work.personId && work.personName) {
    const personJump = document.createElement("div");
    personJump.className = "person-jump";

    const text = document.createElement("div");
    text.innerHTML = `<span>人物</span><strong></strong>`;
    text.querySelector("strong").textContent = work.personName;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = "查看人物";
    button.addEventListener("click", () => {
      goToPerson(work.personId);
    });

    personJump.append(text, button);
    els.metaArea.append(personJump);
  }

  const heading = document.createElement("h4");
  heading.className = "section-title";
  heading.textContent = "视频文件";

  const list = document.createElement("div");
  list.className = "file-list video-picker";

  for (const video of work.videos) {
    const item = document.createElement("div");
    item.className = `file-item${state.currentVideo?.id === video.id ? " active" : ""}`;

    const main = document.createElement("div");
    main.innerHTML = `<div class="file-name"></div><div class="file-sub"></div>`;
    main.querySelector(".file-name").textContent = video.name;
    const progress = video.progress ? ` · 看到 ${Math.floor(video.progress.percent)}%` : "";
    main.querySelector(".file-sub").textContent = `${formatLibraryPath(video.relativePath)} · ${formatBytes(video.size)}${progress}`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = video.playable ? "播放" : "暂不支持";
    button.disabled = !video.playable;
    if (video.playable) {
      button.addEventListener("click", () => {
        reportCurrentProgress();
        renderPlayer(work, video.id);
        renderMeta(work);
      });
    }

    item.append(main, button);
    list.append(item);
  }

  els.metaArea.append(heading, list);
}

function renderInfo(work) {
  els.infoArea.innerHTML = "";

  const heading = document.createElement("h4");
  heading.className = "section-title";
  heading.textContent = "资料文件";
  els.infoArea.append(heading);

  if (!work.infos.length) {
    const empty = document.createElement("div");
    empty.className = "unsupported";
    empty.textContent = "这个作品没有资料文件。";
    els.infoArea.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "info-list";

  for (const info of work.infos) {
    const wrapper = document.createElement("div");
    wrapper.className = "info-block";

    const item = document.createElement("div");
    item.className = "info-item";

    const main = document.createElement("div");
    main.innerHTML = `<div class="file-name"></div><div class="file-sub"></div>`;
    main.querySelector(".file-name").textContent = info.name;
    main.querySelector(".file-sub").textContent = `${formatLibraryPath(info.relativePath)} · ${formatBytes(info.size)}`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = "读取中";
    button.addEventListener("click", () => toggleInfoContent(wrapper, info.id, button));

    item.append(main, button);
    wrapper.append(item);
    list.append(wrapper);
    loadInfoContent(wrapper, info.id, button);
  }

  els.infoArea.append(list);
}

async function loadInfoContent(wrapper, infoId, button) {
  const existing = wrapper.querySelector(".info-content");
  if (existing) return;

  button.textContent = "读取中";
  try {
    const data = await api(`/api/info/${encodeURIComponent(infoId)}`);
    const pre = document.createElement("pre");
    pre.className = "info-content";
    pre.textContent = data.content || "";
    wrapper.append(pre);
    button.textContent = "收起";
  } catch (error) {
    button.textContent = "展开";
    const notice = document.createElement("div");
    notice.className = "unsupported info-error";
    notice.textContent = error.message;
    wrapper.append(notice);
  }
}

function toggleInfoContent(wrapper, infoId, button) {
  const existing = wrapper.querySelector(".info-content, .info-error");
  if (existing) {
    existing.remove();
    button.textContent = "展开";
    return;
  }

  loadInfoContent(wrapper, infoId, button);
}

async function toggleFavorite(workId) {
  const data = await api(`/api/favorites/${encodeURIComponent(workId)}`, { method: "POST" });
  updateWorkFavorite(workId, data.favorite);
  state.library.user = data.user;
  renderSummary();

  if (state.currentWork?.id === workId) {
    state.currentWork.favorite = data.favorite;
    renderPlayer(state.currentWork, state.currentVideo?.id);
  }

  if (state.activeView === "favorites" && !data.favorite) {
    state.works = state.works.filter((work) => work.id !== workId);
  }

  renderWorks(state.activeView === "favorites" ? "还没有收藏。" : "没有匹配的作品。");
}

function updateWorkFavorite(workId, favorite) {
  for (const work of state.works) {
    if (work.id === workId) work.favorite = favorite;
  }
}

function startProgressReporting() {
  stopProgressReporting();
  state.progressTimer = window.setInterval(reportCurrentProgress, 5000);
}

function stopProgressReporting() {
  if (state.progressTimer) {
    window.clearInterval(state.progressTimer);
    state.progressTimer = null;
  }
}

function activeVideoElement() {
  return els.playerArea.querySelector("video");
}

function reportCurrentProgress() {
  const video = activeVideoElement();
  if (!state.currentVideo || !state.currentWork || !video || !Number.isFinite(video.duration) || video.duration <= 0) {
    return;
  }

  const now = Date.now();
  if (now - state.lastProgressReport < 1400) return;
  state.lastProgressReport = now;

  api(`/api/progress/${encodeURIComponent(state.currentVideo.id)}`, {
    method: "POST",
    body: {
      workId: state.currentWork.id,
      position: video.currentTime,
      duration: video.duration
    }
  })
    .then((data) => {
      state.currentVideo.progress = data.progress;
      state.currentWork.progress = data.progress;
      state.library.user = data.user;
      renderSummary();
    })
    .catch(() => {});
}

els.personSearch.addEventListener("input", (event) => {
  state.personQuery = event.target.value;
  renderPeople();
  if (state.activeView === "people" && !state.selectedPersonId) {
    renderPeopleIndexStats();
    renderPeopleIndex();
  }
});

els.workSearch.addEventListener("input", (event) => {
  state.workQuery = event.target.value;
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => {
    loadSearchResults(state.workQuery);
  }, 180);
});

els.sortSelect.addEventListener("change", (event) => {
  state.sortMode = event.target.value;
  renderWorks();
});

els.filterSelect.addEventListener("change", (event) => {
  state.filterMode = event.target.value;
  renderWorks();
});

for (const button of els.viewTabs) {
  button.addEventListener("click", () => {
    clearWorkSearch();
    setActiveView(button.dataset.view);
  });
}

els.rescanButton.addEventListener("click", async () => {
  els.rescanButton.disabled = true;
  els.librarySummary.textContent = "正在重新扫描";
  try {
    const data = await api("/api/rescan", { method: "POST" });
    state.library = { ...(state.library || {}), ...data };
    await loadLibrary();
  } catch (error) {
    alert(error.message);
  } finally {
    els.rescanButton.disabled = false;
  }
});

els.closeDrawer.addEventListener("click", closeDrawer);
els.drawerBackdrop.addEventListener("click", closeDrawer);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDrawer();
  }
});

window.addEventListener("beforeunload", reportCurrentProgress);

loadLibrary().catch((error) => {
  els.librarySummary.textContent = "索引读取失败";
  renderEmpty(error.message);
});
