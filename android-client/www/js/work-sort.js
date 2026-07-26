export function compareWorkRatingCount(a, b) {
  const countResult = ratingCount(b) - ratingCount(a);
  if (countResult) return countResult;
  return compareRatings(a, b);
}

export function compareWorkPopularity(a, b) {
  const popularityResult = popularity(b) - popularity(a);
  if (popularityResult) return popularityResult;
  return compareWorkRatingCount(a, b);
}

function popularity(work) {
  const rating = numericRating(work?.infoSummary?.rating);
  return rating === null ? 0 : rating * ratingCount(work);
}

function compareRatings(a, b) {
  const aRating = numericRating(a?.infoSummary?.rating);
  const bRating = numericRating(b?.infoSummary?.rating);
  if ((aRating !== null) !== (bRating !== null)) return aRating !== null ? -1 : 1;
  if (aRating !== null && aRating !== bRating) return bRating - aRating;
  return 0;
}

function ratingCount(work) {
  const count = Number(work?.infoSummary?.ratingCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function numericRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}
