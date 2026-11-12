import { workCodeKey } from "../../../../../lib/code-parser.js";

function foldSearchText(value) {
  return String(value || "").normalize("NFKC").toLowerCase();
}

export function createWorkTitleMatcher(query, indexedCodeForWork = () => "") {
  const needle = foldSearchText(query);
  const compact = /^[a-z\d\s._\-–—]+$/u.test(needle) && /\d/u.test(needle)
    ? needle.replace(/[^a-z\d]/gu, "") : "";
  const code = compact ? workCodeKey(needle) : "";

  return (work) => {
    const fields = [work.title, work.directoryName, work.infoSummary?.title, work.infoSummary?.code];
    if (fields.some(value => foldSearchText(value).includes(needle))) return true;
    if (!compact) return false;
    return [...fields, indexedCodeForWork(work)].some(value => {
      const text = foldSearchText(value);
      return (code && workCodeKey(text) === code) || text.replace(/[^a-z\d]/gu, "").includes(compact);
    });
  };
}
