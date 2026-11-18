import { matchWorkCodePrefix } from "../../../../../public/modules/fanhao/work-code-prefix.js";

export function workCodePrefix(value) {
  return matchWorkCodePrefix(value)?.prefix || "";
}

export function workCodePrefixForWork(work) {
  for (const value of [
    work?.infoSummary?.code,
    work?.code,
    work?.directoryName,
    work?.title
  ]) {
    const prefix = workCodePrefix(value);
    if (prefix) return prefix;
  }
  return "";
}

export function normalizeRequestedCodePrefix(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replaceAll("_", "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized || normalized.length > 32 || !/[A-Z]/.test(normalized)) return "";
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(normalized) ? normalized : "";
}

export function codePrefixMatches(value, requestedPrefix, family = false) {
  const prefix = normalizeRequestedCodePrefix(requestedPrefix);
  const candidate = workCodePrefixForWork(value);
  if (!prefix || !candidate) return false;
  return family
    ? candidate === prefix || candidate.startsWith(`${prefix}-`)
    : candidate === prefix;
}
