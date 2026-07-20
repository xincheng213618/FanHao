export const STUDIO_SORT_OPTIONS = Object.freeze([
  { value: "count", label: "作品最多", description: "作品最多" },
  { value: "recent", label: "最近更新", description: "最近更新" },
  { value: "name", label: "名称排序", description: "名称 A-Z" }
]);

export function normalizeStudioSort(value) {
  return STUDIO_SORT_OPTIONS.some((option) => option.value === value) ? value : "count";
}

export function selectStudios(studios, options = {}) {
  const query = String(options.query || "").trim().toLocaleLowerCase();
  const sort = normalizeStudioSort(options.sort);
  return (studios || [])
    .filter((studio) => !query || String(studio?.name || "").toLocaleLowerCase().includes(query))
    .slice()
    .sort((a, b) => compareStudios(a, b, sort));
}

function compareStudios(a, b, sort) {
  const byName = () => String(a?.name || "").localeCompare(String(b?.name || ""), "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base"
  });
  const byCount = () => studioWorkCount(b) - studioWorkCount(a);
  const byRecent = () => String(b?.latestReleaseDate || "").localeCompare(String(a?.latestReleaseDate || ""));
  if (sort === "name") return byName() || byCount() || byRecent();
  if (sort === "recent") return byRecent() || byCount() || byName();
  return byCount() || byRecent() || byName();
}

function studioWorkCount(studio) {
  return Number(studio?.localWorkCount || studio?.workCount || 0);
}
