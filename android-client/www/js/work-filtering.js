import { formatNumber } from "./format.js";
import { imageUrlForWork } from "./image.js";
import { compareWorkPopularity, compareWorkRatingCount } from "./work-sort.js?v=20260726-work-sort-01";
import { isVrWork } from "./work-source.js?v=20260710-western-merge-01";

const FILTER_STORAGE_KEY = "fanhao.android.workFilter";
const SORT_STORAGE_KEY = "fanhao.android.workSort";

const WORK_FILTERS = [
  { value: "all", label: "全部" },
  { value: "playable", label: "可播" },
  { value: "favorite", label: "收藏" },
  { value: "progress", label: "在看" },
  { value: "info", label: "资料" },
  { value: "localOnly", label: "本地" },
  { value: "missingLocal", label: "未下载" },
  { value: "rated", label: "有评分" },
  { value: "highRating", label: "高分" },
  { value: "vr", label: "VR" },
  { value: "missingCover", label: "无封面" }
];

const WORK_SORTS = [
  { value: "ranking", label: "榜单" },
  { value: "title", label: "标题" },
  { value: "releaseDesc", label: "发行最新" },
  { value: "releaseAsc", label: "发行最早" },
  { value: "updated", label: "最近更新" },
  { value: "ratingDesc", label: "评分最高" },
  { value: "ratingCountDesc", label: "评价人数最多" },
  { value: "popularityDesc", label: "热度最高" },
  { value: "progress", label: "观看进度" },
  { value: "size", label: "大小" },
  { value: "durationDesc", label: "时长" },
  { value: "videos", label: "视频数" }
];

export function createWorkListState(context) {
  const { renderCurrentView } = context;
  const persist = context.persist !== false;
  const filterStorageKey = context.filterStorageKey || FILTER_STORAGE_KEY;
  const sortStorageKey = context.sortStorageKey || SORT_STORAGE_KEY;
  const storedFilterMode = persist ? localStorage.getItem(filterStorageKey) : null;
  const storedSortMode = persist ? localStorage.getItem(sortStorageKey) : null;
  let filterMode = normalizeFilterMode(storedFilterMode ?? context.initialFilterMode ?? "all");
  let sortMode = validValue(storedSortMode ?? context.initialSortMode, WORK_SORTS, "updated");

  function visibleWorks(works, options = {}) {
    const activeFilter = normalizeFilterMode(options.filterMode ?? filterMode);
    const activeSort = validValue(options.sortMode, WORK_SORTS, sortMode);
    return [...works]
      .filter((work) => workMatchesFilters(work, activeFilter))
      .sort((a, b) => compareWorks(a, b, activeSort));
  }

  function getServerFilterMode() {
    return filterMode;
  }

  function getServerSortMode() {
    if (sortMode === "ranking") return "updated";
    return sortMode;
  }

  function setFilterMode(value, options = {}) {
    const next = options.replace ? normalizeFilterMode(value) : nextFilterMode(filterMode, value);
    if (filterMode === next) return false;
    filterMode = next;
    if (persist && options.persist !== false) localStorage.setItem(filterStorageKey, filterMode);
    if (options.rerender !== false) renderCurrentView();
    return true;
  }

  function setSortMode(value, options = {}) {
    if (!validValue(value, WORK_SORTS, "")) return false;
    if (sortMode === value) return false;
    sortMode = value;
    if (persist && options.persist !== false) localStorage.setItem(sortStorageKey, sortMode);
    if (options.rerender !== false) renderCurrentView();
    return true;
  }

  function createWorkControls(sourceWorks, visibleList, options = {}) {
    const controls = document.createElement("div");
    controls.className = "work-controls";
    const activeFilter = normalizeFilterMode(options.filterMode ?? filterMode);
    const activeFilters = new Set(normalizeFilterList(activeFilter));
    const filterToReveal = activeFilters.size ? [...activeFilters].at(-1) : "all";

    const filterStrip = document.createElement("div");
    filterStrip.className = "work-filter-strip";
    filterStrip.setAttribute("aria-label", "作品筛选");
    let filterButtonToReveal = null;
    for (const option of getFilterOptions(sourceWorks, options.facets)) {
      const count = option.count;
      const button = document.createElement("button");
      button.type = "button";
      const active = option.value === "all" ? activeFilters.size === 0 : activeFilters.has(option.value);
      button.className = active ? "active" : "";
      button.setAttribute("aria-pressed", active ? "true" : "false");
      button.textContent = option.label;
      button.title = `${option.label} · ${formatNumber(count)}`;
      button.setAttribute("aria-label", `${option.label}，${formatNumber(count)} 个作品`);
      button.addEventListener("click", () => {
        if (typeof options.onFilterChange === "function") {
          options.onFilterChange(option.value);
          return;
        }
        setFilterMode(option.value);
      });
      if (option.value === filterToReveal) filterButtonToReveal = button;
      filterStrip.append(button);
    }
    revealActiveFilter(filterStrip, filterButtonToReveal);
    const compactSummary = createCompactSummary(options, sourceWorks.length);
    if (compactSummary) {
      controls.classList.add("has-compact-summary");
      controls.append(compactSummary, filterStrip);
    } else {
      controls.append(filterStrip);
    }
    return controls;
  }

  function getSortOptions(options = {}) {
    const values = options.allowRankingSort
      ? WORK_SORTS
      : WORK_SORTS.filter((option) => option.value !== "ranking");
    return values.map((option) => ({ ...option }));
  }

  function getFilterOptions(works = [], facets = {}) {
    const counts = { ...filterCounts(works), ...(facets || {}) };
    return WORK_FILTERS.map((option) => ({
      ...option,
      count: Math.max(0, Number(counts[option.value] || 0))
    }));
  }

  function filterCounts(works) {
    const counts = Object.fromEntries(WORK_FILTERS.map((option) => [option.value, 0]));
    counts.all = works.length;
    for (const work of works) {
      for (const option of WORK_FILTERS) {
        if (option.value !== "all" && workMatchesFilter(work, option.value)) counts[option.value] += 1;
      }
    }
    return counts;
  }

  function workMatchesFilter(work, mode) {
    if (mode === "all") return true;
    if (mode === "playable") return (work.playableCount || 0) > 0;
    if (mode === "favorite") return Boolean(work.favorite);
    if (mode === "progress") return Boolean(work.progress);
    if (mode === "info") return (work.infoCount || 0) > 0;
    if (mode === "localOnly") return !work.missingLocal;
    if (mode === "missingLocal") return Boolean(work.missingLocal);
    if (mode === "rated") return numericRating(work.infoSummary?.rating) !== null;
    if (mode === "highRating") {
      const rating = numericRating(work.infoSummary?.rating);
      return rating !== null && rating >= 4;
    }
    if (mode === "missingCover") return !work.missingLocal && !imageUrlForWork(work);
    if (mode === "vr") return isVrWork(work);
    return true;
  }

  function workMatchesFilters(work, mode) {
    const filters = normalizeFilterList(mode);
    if (!filters.length) return true;
    return filters.every((filter) => workMatchesFilter(work, filter));
  }

  function compareWorks(a, b, activeSort = sortMode) {
    if (activeSort === "ranking") return byRanking(a, b) || byTitle(a, b);
    if (activeSort === "releaseDesc") return byReleaseDate(a, b, "desc") || byTitle(a, b);
    if (activeSort === "releaseAsc") return byReleaseDate(a, b, "asc") || byTitle(a, b);
    if (activeSort === "updated") return byTextDesc(a.modifiedAt, b.modifiedAt) || byTitle(a, b);
    if (activeSort === "ratingDesc") return byRating(a, b, "desc") || byTitle(a, b);
    if (activeSort === "ratingCountDesc") return compareWorkRatingCount(a, b) || byTitle(a, b);
    if (activeSort === "popularityDesc") return compareWorkPopularity(a, b) || byTitle(a, b);
    if (activeSort === "progress") return byTextDesc(a.progress?.updatedAt, b.progress?.updatedAt) || byTitle(a, b);
    if (activeSort === "size") return (b.videoSize || 0) - (a.videoSize || 0) || byTitle(a, b);
    if (activeSort === "durationDesc") return (b.infoSummary?.durationMinutes || 0) - (a.infoSummary?.durationMinutes || 0) || byTitle(a, b);
    if (activeSort === "videos") return (b.videoCount || 0) - (a.videoCount || 0) || byTitle(a, b);
    return byTitle(a, b);
  }

  function byRanking(a, b) {
    const aRank = Number(a.ranking?.rankNo || 0);
    const bRank = Number(b.ranking?.rankNo || 0);
    const aHas = Number.isFinite(aRank) && aRank > 0;
    const bHas = Number.isFinite(bRank) && bRank > 0;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && aRank !== bRank) return aRank - bRank;
    return 0;
  }

  function byRating(a, b, direction = "desc") {
    const aRating = numericRating(a.infoSummary?.rating);
    const bRating = numericRating(b.infoSummary?.rating);
    const aHas = aRating !== null;
    const bHas = bRating !== null;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (!aHas && !bHas) return byTextDesc(a.modifiedAt, b.modifiedAt);
    if (aRating !== bRating) return direction === "asc" ? aRating - bRating : bRating - aRating;

    const aCount = Number(a.infoSummary?.ratingCount || 0);
    const bCount = Number(b.infoSummary?.ratingCount || 0);
    if (aCount !== bCount) return bCount - aCount;
    return byTextDesc(a.modifiedAt, b.modifiedAt);
  }

  function byReleaseDate(a, b, direction = "desc") {
    const aDate = workReleaseDate(a);
    const bDate = workReleaseDate(b);
    const aHas = Boolean(aDate);
    const bHas = Boolean(bDate);
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aDate !== bDate) return direction === "asc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
    return byTextDesc(a.modifiedAt, b.modifiedAt);
  }

  function workReleaseDate(work) {
    return String(work.infoSummary?.releaseDate || "").trim();
  }

  function numericRating(value) {
    if (value === null || value === undefined || value === "") return null;
    const rating = Number(value);
    return Number.isFinite(rating) ? rating : null;
  }

  function byTextDesc(a, b) {
    return String(b || "").localeCompare(String(a || ""));
  }

  function byTitle(a, b) {
    return String(a.title || a.directoryName || "").localeCompare(String(b.title || b.directoryName || ""), undefined, {
      numeric: true,
      sensitivity: "base"
    });
  }

  return {
    createWorkControls,
    getFilterOptions,
    getFilterMode: () => filterMode,
    getServerFilterMode,
    getServerSortMode,
    getSortOptions,
    getSortMode: () => sortMode,
    setFilterMode,
    setSortMode,
    visibleWorks
  };
}

function createCompactSummary(options, loadedCount) {
  if (!options.compactSummary) return null;
  const loaded = Math.max(0, Number(loadedCount || 0));
  const total = Math.max(loaded, Number(options.total || loaded));
  const summary = document.createElement("span");
  summary.className = "work-control-summary";
  summary.setAttribute("aria-label", `已载入 ${formatNumber(loaded)} 个，共 ${formatNumber(total)} 个作品`);
  summary.title = `${formatNumber(loaded)} / ${formatNumber(total)} 个作品`;

  const current = document.createElement("strong");
  current.textContent = formatNumber(loaded);
  const overall = document.createElement("small");
  overall.textContent = `/ ${formatNumber(total)}`;
  summary.append(current, overall);
  return summary;
}

function revealActiveFilter(filterStrip, button) {
  if (!button || typeof globalThis.requestAnimationFrame !== "function") return;
  globalThis.requestAnimationFrame(() => {
    if (!filterStrip.isConnected || !button.isConnected) return;
    const stripRect = filterStrip.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const centerOffset = (stripRect.width - buttonRect.width) / 2;
    filterStrip.scrollLeft = Math.max(0, filterStrip.scrollLeft + buttonRect.left - stripRect.left - centerOffset);
  });
}

function validValue(value, options, fallback) {
  return options.some((option) => option.value === value) ? value : fallback;
}

function validFilterValue(value) {
  return WORK_FILTERS.some((option) => option.value === value);
}

function normalizeFilterList(value) {
  const raw = Array.isArray(value) ? value : String(value || "all").split(",");
  return [...new Set(raw
    .map((item) => String(item || "").trim())
    .filter((item) => item && item !== "all" && validFilterValue(item)))];
}

function normalizeFilterMode(value) {
  const filters = normalizeFilterList(value);
  return filters.length ? filters.join(",") : "all";
}

function nextFilterMode(current, value) {
  const target = String(value || "").trim();
  if (!validFilterValue(target)) return normalizeFilterMode(current);
  if (target === "all") return "all";

  const filters = normalizeFilterList(current);
  const exists = filters.includes(target);
  const next = exists ? filters.filter((item) => item !== target) : [...filters, target];
  return normalizeFilterMode(next);
}
