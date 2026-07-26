export function compareRatingCountMetadata(a, b) {
  const countResult = ratingCount(b) - ratingCount(a);
  if (countResult) return countResult;
  return compareRatings(a, b);
}

export function comparePopularityMetadata(a, b) {
  const popularityResult = popularity(b) - popularity(a);
  if (popularityResult) return popularityResult;
  return compareRatingCountMetadata(a, b);
}

export function popularity(metadata) {
  const rating = numericRating(metadata?.rating);
  return rating === null ? 0 : rating * ratingCount(metadata);
}

function compareRatings(a, b) {
  const aRating = numericRating(a?.rating);
  const bRating = numericRating(b?.rating);
  if ((aRating !== null) !== (bRating !== null)) return aRating !== null ? -1 : 1;
  if (aRating !== null && aRating !== bRating) return bRating - aRating;
  return 0;
}

function ratingCount(metadata) {
  const count = Number(metadata?.ratingCount);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function numericRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}
