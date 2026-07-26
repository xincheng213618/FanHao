const FC2_PPV_PATTERN = /^FC2[-_\s]?PPV[-_\s]?\d+/i;
const FC2_PATTERN = /^FC2[-_\s]?\d+/i;

export function workCodePrefix(value) {
  const code = normalizeCodeText(value);
  if (!code) return "";
  if (FC2_PPV_PATTERN.test(code)) return "FC2-PPV";
  if (FC2_PATTERN.test(code)) return "FC2";

  const separated = code.match(/^([A-Z0-9]+(?:[-_][A-Z]+)*)[-_\s]+(?=\d)/);
  if (separated?.[1] && /[A-Z]/.test(separated[1])) {
    return separated[1].replaceAll("_", "-");
  }

  const compact = code.match(/^([A-Z]+)(?=\d{2,})/);
  return compact?.[1] || "";
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

function normalizeCodeText(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^(?:\[[^\]]+\][.\s_-]*)+/g, "")
    .replace(/[‐‑‒–—―]/g, "-");
}
