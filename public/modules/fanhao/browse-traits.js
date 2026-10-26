export const EDITION_FILTERS = [
  ["uncensored", "无码"],
  ["uncensoredAi", "无码破解"],
  ["subtitled", "中字"],
  ["quality4k", "4K"]
];

const editionLabels = new Map(EDITION_FILTERS);

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
  addRow("版本 / 画质", EDITION_FILTERS.filter(([key]) => editions.has(key))
    .map(([key, name]) => ({ ...editions.get(key), name, value: key })));
  addRow("内容标签", [...tags.values()].map((item) => ({ ...item, value: tagFilterValue(item.name) })));
  return root;
}

export function createWorkEditionBadges(work) {
  const editions = (work?.traits?.editions || []).filter((item) => editionLabels.has(item.key));
  const unique = new Map(editions.map((item) => [item.key, item]));
  if (unique.has("uncensoredAi")) unique.delete("uncensored");
  if (!unique.size) return null;
  const root = document.createElement("div");
  root.className = "work-edition-badges";
  for (const [key, name] of EDITION_FILTERS) {
    if (!unique.has(key)) continue;
    const item = unique.get(key);
    const badge = document.createElement("span");
    badge.className = `work-edition-badge edition-${key}`;
    badge.textContent = name;
    const evidence = (Array.isArray(item.evidence) ? item.evidence : []).filter((value) => typeof value === "string" && value.trim());
    badge.title = `${name} · 识别依据：${evidence.length ? evidence.join("；") : "资料标记"}。标记来自文件或资料线索，未核验视频画面。`;
    badge.setAttribute("aria-label", badge.title);
    root.append(badge);
  }
  return root;
}

export function createWorkTagButtons(work, { filters = [], toggle }) {
  const names = [...new Set((work?.traits?.tags || []).filter((name) => typeof name === "string" && name.trim()))].slice(0, 3);
  if (!names.length) return null;
  const root = document.createElement("div");
  root.className = "work-tag-buttons";
  for (const name of names) {
    const value = tagFilterValue(name);
    const active = filters.includes(value);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `work-tag-button${active ? " active" : ""}`;
    button.textContent = name;
    button.dataset.workFilter = value;
    button.title = `筛选标签：${name}`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-pressed", String(active));
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle(value);
    });
    root.append(button);
  }
  return root;
}
