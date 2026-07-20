export function createWorkFilterService({
  favoriteStateService = { isFavoriteWork: () => false },
  isVrWork = () => false,
  playbackProgressService = { getWorkProgress: () => null },
  publicWorkAvailability = () => ({}),
  workHasCoreCover = () => false,
  workHasLocalMarker = () => false,
  workInfoFacetRow = () => null
} = {}) {
  function ratingFor(work) {
    return optionalNumber(workInfoFacetRow(work.id)?.rating, work.infoSummary?.rating);
  }

  function matches(work, filter) {
    switch (filter) {
      case "localOnly": return !work.missingLocal;
      case "missingLocal": return Boolean(work.missingLocal);
      case "playable": return Number(work.playableCount || 0) > 0;
      case "favorite": return favoriteStateService.isFavoriteWork(work.id);
      case "progress": return Boolean(playbackProgressService.getWorkProgress(work));
      case "info": return Boolean(workInfoFacetRow(work.id)) || Number(work.infoCount || 0) > 0;
      case "rated": return ratingFor(work) !== null;
      case "highRating": return (ratingFor(work) ?? -Infinity) >= 4;
      case "vr": return isVrWork(work);
      case "localMarkedA": return workHasLocalMarker(work, "A");
      case "hasMagnet": return Boolean(work.missingLocal && publicWorkAvailability(work).hasMagnet);
      case "missingCover": return !work.missingLocal && !work.coverId && !workHasCoreCover(work.id);
      case "all":
      default: return true;
    }
  }

  function filters(value) {
    return [...new Set(String(value || "all")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item && item !== "all"))];
  }

  function filter(works = [], value = "all") {
    const requested = filters(value);
    return requested.length ? works.filter((work) => requested.every((item) => matches(work, item))) : works;
  }

  function facets(works = []) {
    const counts = {
      all: works.length, playable: 0, favorite: 0, progress: 0, info: 0,
      localOnly: 0, missingLocal: 0, rated: 0, highRating: 0, vr: 0,
      hasMagnet: 0, missingCover: 0
    };
    for (const work of works) {
      const missingLocal = Boolean(work.missingLocal);
      const infoRow = workInfoFacetRow(work.id);
      const rating = optionalNumber(infoRow?.rating, work.infoSummary?.rating);
      if (Number(work.playableCount || 0) > 0) counts.playable += 1;
      if (favoriteStateService.isFavoriteWork(work.id)) counts.favorite += 1;
      if (playbackProgressService.getWorkProgress(work)) counts.progress += 1;
      if (infoRow || Number(work.infoCount || 0) > 0) counts.info += 1;
      if (missingLocal) counts.missingLocal += 1;
      else counts.localOnly += 1;
      if (rating !== null) counts.rated += 1;
      if (rating !== null && rating >= 4) counts.highRating += 1;
      if (isVrWork(work)) counts.vr += 1;
      if (missingLocal && publicWorkAvailability(work).hasMagnet) counts.hasMagnet += 1;
      if (!missingLocal && !work.coverId && !workHasCoreCover(work.id)) counts.missingCover += 1;
    }
    return counts;
  }

  return { facets, filter, filters, matches };
}

function optionalNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}
