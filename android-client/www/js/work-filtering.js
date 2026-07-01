import { formatNumber } from "./format.js";
import { imageUrlForWork } from "./image.js";
import { isVrWork } from "./work-source.js";

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
  { value: "ratingAsc", label: "评分最低" },
  { value: "progress", label: "观看进度" },
  { value: "size", label: "大小" },
  { value: "durationDesc", label: "时长" },
  { value: "videos", label: "视频数" }
];

export function createWorkListState(context) {
  const { renderCurrentView } = context;
  let filterMode = validValue(localStorage.getItem(FILTER_STORAGE_KEY), WORK_FILTERS, "all");
  let sortMode = validValue(localStorage.getItem(SORT_STORAGE_KEY), WORK_SORTS, "updated");

  function visibleWorks(works, options = {}) {
    const activeFilter = validValue(options.filterMode, WORK_FILTERS, filterMode);
    const activeSort = validValue(options.sortMode, WORK_SORTS, sortMode);
    return [...works]
      .filter((work) => workMatchesFilter(work, activeFilter))
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
    if (!validValue(value, WORK_FILTERS, "")) return false;
    if (filterMode === value) return false;
    filterMode = value;
    if (options.persist !== false) localStorage.setItem(FILTER_STORAGE_KEY, filterMode);
    if (options.rerender !== false) renderCurrentView();
    return true;
  }

  function setSortMode(value, options = {}) {
    if (!validValue(value, WORK_SORTS, "")) return false;
    if (sortMode === value) return false;
    sortMode = value;
    if (options.persist !== false) localStorage.setItem(SORT_STORAGE_KEY, sortMode);
    if (options.rerender !== false) renderCurrentView();
    return true;
  }

  function createWorkControls(sourceWorks, visibleList, options = {}) {
    const controls = document.createElement("div");
    controls.className = "work-controls";
    const activeFilter = validValue(options.filterMode, WORK_FILTERS, filterMode);
    const activeSort = validValue(options.sortMode, WORK_SORTS, sortMode);

    const filterStrip = document.createElement("div");
    filterStrip.className = "work-filter-strip";
    const counts = { ...filterCounts(sourceWorks), ...(options.facets || {}) };
    for (const option of WORK_FILTERS) {
      const count = counts[option.value] || 0;
      const button = document.createElement("button");
      button.type = "button";
      button.className = activeFilter === option.value ? "active" : "";
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
      filterStrip.append(button);
    }

    const sortRow = document.createElement("div");
    sortRow.className = "work-sort-row";
    const summary = document.createElement("span");
    const displayedCount = Number.isFinite(Number(options.displayedCount))
      ? Number(options.displayedCount)
      : visibleList.length;
    const allTotal = Number.isFinite(Number(options.total)) ? Number(options.total) : sourceWorks.length;
    const activeTotalValue = activeFilter === "all" ? allTotal : counts[activeFilter];
    const activeTotal = Number.isFinite(Number(activeTotalValue)) ? Number(activeTotalValue) : allTotal;
    summary.textContent = `显示 ${formatNumber(displayedCount)} / ${formatNumber(activeTotal)}`;
    const select = document.createElement("select");
    select.setAttribute("aria-label", "作品排序");
    const sortOptions = options.allowRankingSort ? WORK_SORTS : WORK_SORTS.filter((option) => option.value !== "ranking");
    for (const option of sortOptions) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      item.selected = activeSort === option.value;
      select.append(item);
    }
    select.addEventListener("change", () => {
      if (typeof options.onSortChange === "function") {
        options.onSortChange(select.value);
        return;
      }
      setSortMode(select.value);
    });
    sortRow.append(summary, select);

    controls.append(filterStrip, sortRow);
    return controls;
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

  function compareWorks(a, b, activeSort = sortMode) {
    if (activeSort === "ranking") return byRanking(a, b) || byTitle(a, b);
    if (activeSort === "releaseDesc") return byReleaseDate(a, b, "desc") || byTitle(a, b);
    if (activeSort === "releaseAsc") return byReleaseDate(a, b, "asc") || byTitle(a, b);
    if (activeSort === "updated") return byTextDesc(a.modifiedAt, b.modifiedAt) || byTitle(a, b);
    if (activeSort === "ratingDesc") return byRating(a, b, "desc") || byTitle(a, b);
    if (activeSort === "ratingAsc") return byRating(a, b, "asc") || byTitle(a, b);
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
    getFilterMode: () => filterMode,
    getServerFilterMode,
    getServerSortMode,
    getSortMode: () => sortMode,
    setFilterMode,
    setSortMode,
    visibleWorks
  };
}

function validValue(value, options, fallback) {
  return options.some((option) => option.value === value) ? value : fallback;
}
