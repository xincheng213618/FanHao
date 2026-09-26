export const WORK_SCOPE_FILTERS = ["all", "localOnly", "playable", "missingLocal"];
const COMMON_FILTERS = ["favorite", "progress", "vr", "localMarkedA"];

export function nextBrowseFilters(filters, value) {
  if (WORK_SCOPE_FILTERS.includes(value)) {
    const next = filters.filter((filter) => !WORK_SCOPE_FILTERS.includes(filter));
    return value === "all" ? next : [...next, value];
  }
  return filters.includes(value) ? filters.filter((filter) => filter !== value) : [...filters, value];
}

export function createBrowseFilterControls({ options, filters, includeMissing, toggle, clear }) {
  const root = document.createElement("div");
  root.className = "browse-filter-controls stat-filter-list";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "作品筛选");
  const selectedScope = WORK_SCOPE_FILTERS.find((value) => filters.includes(value))
    || (includeMissing ? "all" : "localOnly");
  const labels = new Map(options);
  function chip(value, scope = false) {
    const active = scope ? selectedScope === value : filters.includes(value);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stat-filter-chip${active ? " active" : ""}`;
    button.textContent = labels.get(value);
    button.dataset.workFilter = value;
    button.setAttribute("aria-pressed", String(active));
    button.addEventListener("click", () => toggle(value));
    return button;
  }
  function row(label, values, scope = false) {
    const group = document.createElement("div");
    group.className = scope ? "browse-filter-scopes" : "browse-filter-extras";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    group.append(...values.map((value) => chip(value, scope)));
    return group;
  }
  root.append(row("作品范围", WORK_SCOPE_FILTERS, true));
  const extras = row("附加条件", COMMON_FILTERS);
  const advanced = options.map(([value]) => value)
    .filter((value) => !WORK_SCOPE_FILTERS.includes(value) && !COMMON_FILTERS.includes(value));
  const details = document.createElement("details");
  details.className = "browse-more-filters";
  const activeCount = advanced.filter((value) => filters.includes(value)).length;
  details.open = activeCount > 0;
  const summary = document.createElement("summary");
  summary.textContent = activeCount ? `更多筛选 · ${activeCount}` : "更多筛选";
  details.append(summary, row("更多条件", advanced));
  extras.append(details);
  if (filters.length) {
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "browse-filter-reset";
    reset.textContent = "清除筛选";
    reset.addEventListener("click", clear);
    extras.append(reset);
  }
  root.append(extras);
  return root;
}
