export function selectVisibleWorks(works, options = {}) {
  const query = String(options.query || "").trim().toLowerCase();
  const filters = Array.isArray(options.filters) ? options.filters : [];
  const includesText = options.includesText || defaultIncludesText;
  const workSearchText = options.workSearchText || defaultWorkSearchText;
  const isCompilation = options.isCompilation || (() => false);
  const matchesFilter = options.matchesFilter || (() => true);
  const compareTitle = options.compareTitle || compareWorkTitle;

  let visible = (works || []).filter((work) => {
    if (!query) return true;
    return includesText(work?.title, query)
      || includesText(work?.directoryName, query)
      || includesText(work?.relativePath, query)
      || includesText(workSearchText(work), query);
  });

  if (!options.showCompilationWorks) {
    visible = visible.filter((work) => !isCompilation(work));
  }
  if (!options.showMissingLocalWorks && !filters.includes("missingLocal")) {
    visible = visible.filter((work) => !work?.missingLocal);
  }
  visible = visible.filter((work) => filters.every((filter) => matchesFilter(work, filter)));

  const sortMode = options.sortMode || "title";
  visible.sort((a, b) => {
    if (sortMode === "ranking") return compareWorkRanking(a, b) || compareTitle(a, b);
    if (sortMode === "releaseDesc") return compareWorkReleaseDate(a, b, "desc") || compareTitle(a, b);
    if (sortMode === "releaseAsc") return compareWorkReleaseDate(a, b, "asc") || compareTitle(a, b);
    if (sortMode === "updated") return String(b?.modifiedAt || "").localeCompare(String(a?.modifiedAt || ""));
    if (sortMode === "ratingDesc") return compareWorkRating(a, b, "desc") || compareTitle(a, b);
    if (sortMode === "ratingAsc") return compareWorkRating(a, b, "asc") || compareTitle(a, b);
    if (sortMode === "ratingCountDesc") return compareWorkRatingCount(a, b) || compareTitle(a, b);
    if (sortMode === "popularityDesc") return compareWorkPopularity(a, b) || compareTitle(a, b);
    if (sortMode === "progress") return String(b?.progress?.updatedAt || "").localeCompare(String(a?.progress?.updatedAt || ""));
    if (sortMode === "sizeDesc") return Number(b?.videoSize || 0) - Number(a?.videoSize || 0) || compareTitle(a, b);
    if (sortMode === "durationDesc") {
      return Number(b?.infoSummary?.durationMinutes || 0) - Number(a?.infoSummary?.durationMinutes || 0) || compareTitle(a, b);
    }
    if (sortMode === "videos") {
      return Number(b?.videoCount || 0) - Number(a?.videoCount || 0) || compareTitle(a, b);
    }
    return compareTitle(a, b);
  });
  return visible;
}

export function compareWorkRanking(a, b) {
  const aRank = Number(a?.ranking?.rankNo || 0);
  const bRank = Number(b?.ranking?.rankNo || 0);
  const aHas = Number.isFinite(aRank) && aRank > 0;
  const bHas = Number.isFinite(bRank) && bRank > 0;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && aRank !== bRank) return aRank - bRank;
  return 0;
}

export function compareWorkRating(a, b, direction = "desc") {
  const aRating = numericRating(a?.infoSummary?.rating);
  const bRating = numericRating(b?.infoSummary?.rating);
  const aHas = aRating !== null;
  const bHas = bRating !== null;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (!aHas && !bHas) return String(b?.modifiedAt || "").localeCompare(String(a?.modifiedAt || ""));
  if (aRating !== bRating) return direction === "asc" ? aRating - bRating : bRating - aRating;
  const aCount = Number(a?.infoSummary?.ratingCount || 0);
  const bCount = Number(b?.infoSummary?.ratingCount || 0);
  if (aCount !== bCount) return bCount - aCount;
  return String(b?.modifiedAt || "").localeCompare(String(a?.modifiedAt || ""));
}

export function compareWorkRatingCount(a, b) {
  const countResult = workRatingCount(b) - workRatingCount(a);
  if (countResult) return countResult;
  return compareWorkRating(a, b, "desc");
}

export function compareWorkPopularity(a, b) {
  const popularityResult = workPopularity(b) - workPopularity(a);
  if (popularityResult) return popularityResult;
  return compareWorkRatingCount(a, b);
}

export function workPopularity(work) {
  const rating = numericRating(work?.infoSummary?.rating);
  return rating === null ? 0 : rating * workRatingCount(work);
}

function workRatingCount(work) {
  const count = Number(work?.infoSummary?.ratingCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function compareWorkReleaseDate(a, b, direction = "desc") {
  const aDate = String(a?.infoSummary?.releaseDate || "").trim();
  const bDate = String(b?.infoSummary?.releaseDate || "").trim();
  if (Boolean(aDate) !== Boolean(bDate)) return aDate ? -1 : 1;
  if (aDate !== bDate) return direction === "asc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
  return String(b?.modifiedAt || "").localeCompare(String(a?.modifiedAt || ""));
}

export function numericRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

export function compareWorkTitle(a, b) {
  return String(a?.title || a?.directoryName || "").localeCompare(String(b?.title || b?.directoryName || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function defaultIncludesText(value, query) {
  return String(value || "").toLowerCase().includes(query);
}

function defaultWorkSearchText(work) {
  return [work?.infoSummary?.title, work?.infoSummary?.code, work?.personName, work?.person?.name].filter(Boolean).join(" ");
}
