export function createWorkClassificationService({ appConfigService }) {
  function currentConfig() {
    return appConfigService?.current?.() || {};
  }

  function visibilityStamp() {
    const config = currentConfig();
    return JSON.stringify([
      ...(config.compilationPrefixes || []),
      "|",
      ...(config.compilationKeywords || [])
    ]);
  }

  function isCompilation(work) {
    if (!work?.missingLocal) return false;
    const config = currentConfig();
    const prefixes = config.compilationPrefixes || [];
    const keywords = config.compilationKeywords || [];
    const code = String(work.infoSummary?.code || work.code || work.directoryName || work.title || "").trim();
    const codePrefix = code.match(/^([A-Z0-9]+)[-_\s]?\d+/i)?.[1]?.toUpperCase() || "";
    if (codePrefix && prefixes.includes(codePrefix)) return true;

    const text = `${work.title || ""} ${work.directoryName || ""} ${work.infoSummary?.title || ""}`;
    const upperText = text.toUpperCase();
    if (prefixes.some((prefix) => new RegExp(`(^|[^A-Z0-9])${escapeRegExp(prefix)}[-_\\s]?\\d+`, "i").test(text))) {
      return true;
    }
    return keywords.some((keyword) => upperText.includes(String(keyword).toUpperCase()));
  }

  function filterForRequest(works, url, filter = "all") {
    const filters = requestedFilters(filter);
    const includeMissingLocal = requestFlag(url, "includeMissingLocal", true);
    const includeCompilation = requestFlag(url, "includeCompilation", true);
    return (works || []).filter((work) => {
      if (!includeCompilation && isCompilation(work)) return false;
      if (!includeMissingLocal && !filters.includes("missingLocal") && work?.missingLocal) return false;
      return true;
    });
  }

  return {
    filterForRequest,
    isCompilation,
    visibilityStamp
  };
}

function requestedFilters(value) {
  return String(value || "all")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item !== "all");
}

function requestFlag(url, name, fallback) {
  if (!url?.searchParams?.has(name)) return fallback;
  return url.searchParams.get(name) === "1";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
