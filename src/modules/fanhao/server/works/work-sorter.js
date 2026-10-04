import { comparePopularityMetadata, compareRatingCountMetadata } from "./work-sort-metadata.js";

const textCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const metadataSorts = new Set([
  "releaseDesc", "releaseAsc", "ratingAsc", "ratingDesc", "ratingCountDesc",
  "popularityDesc", "duration", "durationDesc", "durationAsc", "codeAsc", "codeDesc"
]);

// Both the query service and the legacy composition adapters use the same
// ordering. Per-sort derived values never survive their source snapshot.
export function createWorkSorter({
  metadataForWork,
  progressForWork,
  displayWorkTitle = (value) => String(value || "")
}) {
  return function sortWorks(works, sort, options = {}) {
    const list = [...works];
    const metadata = metadataSorts.has(sort)
      ? new Map(list.map((work) => [work, metadataForWork(work, options)]))
      : null;
    const progress = sort === "progress"
      ? new Map(list.map((work) => [work, String(progressForWork(work)?.updatedAt || "")]))
      : null;
    const sizes = ["size", "sizeDesc", "sizeAsc"].includes(sort)
      ? new Map(list.map((work) => [work, (work.videos || []).reduce((sum, video) => sum + Number(video.size || 0), 0)]))
      : null;
    const titles = new Map();
    function title(work) {
      if (!titles.has(work)) titles.set(work, displayWorkTitle(work.title || work.directoryName));
      return titles.get(work);
    }
    function compareTitles(a, b) {
      return textCollator.compare(title(a), title(b));
    }
    list.sort((a, b) => {
      const am = metadata?.get(a);
      const bm = metadata?.get(b);
      if (sort === "title") return compareTitles(a, b);
      if (sort === "progress") return progress.get(b).localeCompare(progress.get(a)) || compareTitles(a, b);
      if (sort === "videos") return Number(b.videoCount || 0) - Number(a.videoCount || 0) || compareTitles(a, b);

      if (sort === "releaseDesc" || sort === "releaseAsc") {
        const ah = Boolean(am.releaseDate);
        const bh = Boolean(bm.releaseDate);
        if (ah !== bh) return ah ? -1 : 1;
        if (am.releaseDate !== bm.releaseDate) {
          return sort === "releaseAsc" ? am.releaseDate.localeCompare(bm.releaseDate) : bm.releaseDate.localeCompare(am.releaseDate);
        }
      }
      if (sort === "ratingAsc" || sort === "ratingDesc") {
        const ah = am.rating !== null;
        const bh = bm.rating !== null;
        if (ah !== bh) return ah ? -1 : 1;
        if (ah && am.rating !== bm.rating) return sort === "ratingAsc" ? am.rating - bm.rating : bm.rating - am.rating;
        const countDiff = bm.ratingCount - am.ratingCount;
        if (countDiff) return countDiff;
      }
      if (sort === "ratingCountDesc") {
        const result = compareRatingCountMetadata(am, bm);
        if (result) return result;
      }
      if (sort === "popularityDesc") {
        const result = comparePopularityMetadata(am, bm);
        if (result) return result;
      }
      if (sizes && sizes.get(a) !== sizes.get(b)) {
        return sort === "sizeAsc" ? sizes.get(a) - sizes.get(b) : sizes.get(b) - sizes.get(a);
      }
      if (["duration", "durationDesc", "durationAsc"].includes(sort) && am.duration !== bm.duration) {
        return sort === "durationAsc" ? am.duration - bm.duration : bm.duration - am.duration;
      }
      if (sort === "codeAsc" || sort === "codeDesc") {
        const result = textCollator.compare(am.code, bm.code);
        if (result) return sort === "codeDesc" ? -result : result;
      }
      return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")) || compareTitles(a, b);
    });
    return list;
  };
}
