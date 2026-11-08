const VERSION_FILTERS = [
  ["uncensored", "无码"],
  ["uncensoredAi", "无码破解"],
  ["subtitled", "中字"],
  ["ltx", "LTX"]
];
const QUALITY_FILTERS = [["quality4k", "4K"], ["quality1080p", "1080p"], ["quality720p", "720p"]];
const FORMAT_FILTERS = [["formatMp4", "MP4"], ["formatMkv", "MKV"], ["formatWmv", "WMV"]];
export const EDITION_FILTERS = [...VERSION_FILTERS, ...QUALITY_FILTERS, ...FORMAT_FILTERS];
const CLASSIFICATION_LABELS = new Map([["ltx", "LTX"], ...[...QUALITY_FILTERS, ...FORMAT_FILTERS].map(([, label]) => [label.toLowerCase(), label])]);

const editionLabels = new Map(EDITION_FILTERS);

export function classificationQuery(key, query = "") {
  const normalized = String(key || "").toLowerCase();
  return CLASSIFICATION_LABELS.has(normalized) ? `class:${normalized}${query ? ` ${query}` : ""}` : "";
}

export function parseClassificationQuery(value) {
  const match = /^class:(\S+)(?:\s+([\s\S]+))?$/i.exec(String(value || "").trim());
  const key = match?.[1].toLowerCase();
  const label = CLASSIFICATION_LABELS.get(key);
  return label ? { key, label, query: match[2] || "" } : null;
}

function classificationHref(key) {
  const params = new URLSearchParams(globalThis.location?.search || "");
  const target = new URLSearchParams({ classification: key });
  for (const name of ["client", "returnTo"]) if (params.has(name)) target.set(name, params.get(name));
  return `/fanhao?${target}`;
}

export function createClassificationNav(active) {
  const nav = document.createElement("nav");
  nav.className = "work-classification-nav";
  nav.setAttribute("aria-label", "媒体分类");
  for (const [key, label] of CLASSIFICATION_LABELS) {
    const link = document.createElement("a");
    link.className = `browse-trait-chip${active === key ? " active" : ""}`;
    link.href = classificationHref(key);
    link.textContent = label;
    if (active === key) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  return nav;
}

export function tagFilterValue(name) {
  return `tag:${encodeURIComponent(String(name || "").trim())}`;
}

export function tagFilterName(filter) {
  if (!String(filter || "").startsWith("tag:")) return null;
  try { return decodeURIComponent(filter.slice(4)).trim() || null; }
  catch { return null; }
}

export function traitFilterLabel(filter) {
  return editionLabels.get(filter) || tagFilterName(filter);
}

export function workMatchesTraitFilter(work, filter) {
  if (editionLabels.has(filter)) return work?.traits?.flags?.[filter] === true;
  if (String(filter).startsWith("tag:")) {
    const name = tagFilterName(filter);
    return Boolean(name && work?.traits?.tags?.includes(name));
  }
  return null;
}

export function loadedTraitFacets(works = []) {
  const tags = new Map();
  const editions = new Map();
  for (const work of works) {
    for (const name of new Set((work?.traits?.tags || []).filter((tag) => typeof tag === "string" && tag.trim()))) {
      tags.set(name, (tags.get(name) || 0) + 1);
    }
    for (const [key] of EDITION_FILTERS) {
      if (workMatchesTraitFilter(work, key)) editions.set(key, (editions.get(key) || 0) + 1);
    }
  }
  return {
    total: works.length,
    tags: [...tags].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans")),
    editions: EDITION_FILTERS.filter(([key]) => editions.has(key))
      .map(([key, name]) => ({ key, name, count: editions.get(key) }))
  };
}

export function createBrowseTraitControls({ facets, filters = [], toggle, loadedOnly = false }) {
  const tags = new Map((facets?.tags || []).map((item) => [String(item.name), item]));
  const editions = new Map((facets?.editions || []).filter((item) => editionLabels.has(item.key)).map((item) => [item.key, item]));
  // Keep selected conditions visible even when their intersection has no results.
  for (const filter of filters) {
    const name = tagFilterName(filter);
    if (name && !tags.has(name)) tags.set(name, { name, count: 0 });
    if (editionLabels.has(filter) && !editions.has(filter)) editions.set(filter, { key: filter, count: 0 });
  }
  if (!tags.size && !editions.size) return null;

  const root = document.createElement("section");
  root.className = "browse-traits";
  root.setAttribute("aria-label", "标签与版本筛选");
  const note = document.createElement("div");
  note.className = "browse-traits-note";
  const total = Math.max(0, Number(facets?.total) || 0).toLocaleString("zh-CN");
  note.textContent = loadedOnly
    ? `仅统计已加载的 ${total} 部 · 多个条件同时满足`
    : `当前结果 ${total} 部 · 多个条件同时满足`;
  root.append(note);

  function addRow(label, values) {
    if (!values.length) return;
    const row = document.createElement("div");
    row.className = "browse-trait-row";
    const heading = document.createElement("span");
    heading.className = "browse-trait-heading";
    heading.textContent = label;
    const list = document.createElement("div");
    list.className = "browse-trait-scroll";
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", label);
    for (const { value, name, count } of values) {
      const active = filters.includes(value);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `browse-trait-chip${active ? " active" : ""}`;
      button.dataset.workFilter = value;
      button.setAttribute("aria-pressed", String(active));
      button.setAttribute("aria-label", `${name}，${Math.max(0, Number(count) || 0).toLocaleString("zh-CN")} 部`);
      const caption = document.createElement("span");
      caption.textContent = name;
      const number = document.createElement("span");
      number.className = "browse-trait-count";
      number.textContent = Math.max(0, Number(count) || 0).toLocaleString("zh-CN");
      number.setAttribute("aria-hidden", "true");
      button.append(caption, number);
      button.addEventListener("click", () => toggle(value));
      list.append(button);
    }
    row.append(heading, list);
    root.append(row);
  }
  for (const [label, options] of [["版本", VERSION_FILTERS], ["分辨率", QUALITY_FILTERS], ["格式", FORMAT_FILTERS]]) {
    addRow(label, options.filter(([key]) => editions.has(key))
      .map(([key, name]) => ({ ...editions.get(key), name, value: key })));
  }
  addRow("内容标签", [...tags.values()].map((item) => ({ ...item, value: tagFilterValue(item.name) })));
  return root;
}
