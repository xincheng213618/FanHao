export function normalizePersonWorkYear(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "unknown") return normalized;
  return /^(?:19|20)\d{2}$/.test(normalized) ? normalized : "all";
}

export function personWorkYear(work) {
  const releaseDate = String(work?.infoSummary?.releaseDate || work?.releaseDate || "").trim();
  return releaseDate.match(/^((?:19|20)\d{2})/)?.[1] || "unknown";
}

export function worksForPersonYear(works, requestedYear) {
  const list = Array.isArray(works) ? works : [];
  const year = normalizePersonWorkYear(requestedYear);
  return year === "all" ? list : list.filter((work) => personWorkYear(work) === year);
}

export function personWorkYearOptions(works) {
  const list = Array.isArray(works) ? works : [];
  const counts = new Map();
  for (const work of list) {
    const year = personWorkYear(work);
    counts.set(year, (counts.get(year) || 0) + 1);
  }
  const years = [...counts.keys()]
    .filter((year) => year !== "unknown")
    .sort((left, right) => right.localeCompare(left));
  const options = [
    { value: "all", label: "全部年份", count: list.length },
    ...years.map((year) => ({ value: year, label: `${year} 年`, count: counts.get(year) }))
  ];
  if (counts.has("unknown")) options.push({ value: "unknown", label: "日期未知", count: counts.get("unknown") });
  return options;
}
