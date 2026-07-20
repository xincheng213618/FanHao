export const WORK_CATEGORY_OPTIONS = Object.freeze([
  { value: "censored", label: "有码" },
  { value: "western", label: "欧美" },
  { value: "fc2", label: "FC2" },
  { value: "anime", label: "动漫" }
]);

export function normalizeWorkCategory(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return WORK_CATEGORY_OPTIONS.some((option) => option.value === normalized) ? normalized : "all";
}

export function classifyWorkCategory(work, options = {}) {
  if (options.isWestern) return "western";
  if (isAnimeWork(work)) return "anime";
  if (isFc2Work(work)) return "fc2";
  return "censored";
}

export function isAnimeWork(work) {
  const person = String(work?.personName || "").trim().toLocaleLowerCase();
  if (/^\[?(?:动漫|動畫|anime)\]?$/iu.test(person)) return true;
  return workPaths(work).some((value) => /(?:^|[\\/])\[?(?:动漫|動畫|anime)\]?(?:[\\/]|$)/iu.test(value));
}

export function isFc2Work(work) {
  const values = [
    work?.infoSummary?.code,
    work?.code,
    work?.directoryName,
    work?.title
  ];
  return values.some((value) => /(?:^|[^a-z0-9])fc2(?:[-_\s]*(?:ppv)?[-_\s]*\d+)/iu.test(String(value || "")));
}

function workPaths(work) {
  return [
    work?.relativePath,
    ...(work?.videos || []).map((file) => file?.relativePath || file?.path),
    ...(work?.images || []).map((file) => file?.relativePath || file?.path),
    ...(work?.infos || []).map((file) => file?.relativePath || file?.path)
  ].filter(Boolean).map(String);
}
