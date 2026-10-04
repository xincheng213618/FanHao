import { formatNumber } from "./format.js";
import { openMobileActionSheet } from "./mobile-action-sheet.js?v=assets-07b744082137";

const COMPACT_PRIMARY_FILTERS = Object.freeze(["all", "playable", "progress"]);

export function createWorkFilterControls(config = {}) {
  const filterOptions = Array.isArray(config.filterOptions) ? config.filterOptions : [];
  const activeFilters = new Set(config.activeFilters || []);
  const compact = Boolean(config.options?.compactSummary);
  const controls = document.createElement("div");
  controls.className = "work-controls";
  const filterStrip = document.createElement("div");
  filterStrip.className = compact ? "work-filter-strip is-compact" : "work-filter-strip";
  filterStrip.setAttribute("aria-label", "作品筛选");

  const visibleOptions = compact
    ? COMPACT_PRIMARY_FILTERS.map((value) => filterOptions.find((option) => option.value === value)).filter(Boolean)
    : filterOptions;
  let activeButton = null;
  for (const option of visibleOptions) {
    const button = createFilterButton(option, activeFilters, config.onSelect);
    if (isFilterActive(option.value, activeFilters)) activeButton = button;
    filterStrip.append(button);
  }

  if (compact) {
    filterStrip.append(createMoreFilterButton(filterOptions, activeFilters, config.onSelect));
  } else {
    revealActiveFilter(filterStrip, activeButton);
  }

  const summary = createCompactSummary(config.options, config.loadedCount);
  if (summary) {
    controls.classList.add("has-compact-summary");
    controls.append(summary, filterStrip);
  } else {
    controls.append(filterStrip);
  }
  return controls;
}

function createFilterButton(option, activeFilters, onSelect) {
  const active = isFilterActive(option.value, activeFilters);
  const count = Math.max(0, Number(option.count || 0));
  const button = document.createElement("button");
  button.type = "button";
  button.classList.toggle("active", active);
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.textContent = option.label;
  button.title = `${option.label} · ${formatNumber(count)}`;
  button.setAttribute("aria-label", `${option.label}，${formatNumber(count)} 个作品`);
  button.addEventListener("click", () => onSelect?.(option.value));
  return button;
}

function createMoreFilterButton(filterOptions, activeFilters, onSelect) {
  const secondary = filterOptions.filter((option) => !COMPACT_PRIMARY_FILTERS.includes(option.value));
  const selected = secondary.filter((option) => activeFilters.has(option.value));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "work-filter-more";
  button.classList.toggle("active", selected.length > 0);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-pressed", selected.length > 0 ? "true" : "false");
  button.textContent = selected.length ? `筛选 ${selected.length}` : "筛选";
  button.setAttribute("aria-label", selected.length
    ? `更多筛选，已选择 ${selected.map((option) => option.label).join("、")}`
    : "更多作品筛选");
  button.addEventListener("click", () => {
    openMobileActionSheet({
      title: "更多筛选",
      options: secondary.map((option) => ({
        value: option.value,
        label: `${option.label} · ${formatNumber(option.count || 0)}`,
        active: activeFilters.has(option.value),
        select: () => onSelect?.(option.value)
      }))
    });
  });
  return button;
}

function isFilterActive(value, activeFilters) {
  return value === "all" ? activeFilters.size === 0 : activeFilters.has(value);
}

function createCompactSummary(options = {}, loadedCount = 0) {
  if (!options.compactSummary) return null;
  const loaded = Math.max(0, Number(loadedCount || 0));
  const total = Math.max(loaded, Number(options.total || loaded));
  const summary = document.createElement("span");
  summary.className = "work-control-summary";
  summary.setAttribute("aria-label", `已载入 ${formatNumber(loaded)} 个，共 ${formatNumber(total)} 个作品`);
  summary.title = `${formatNumber(loaded)} / ${formatNumber(total)} 个作品`;
  const current = document.createElement("strong");
  current.textContent = formatNumber(loaded);
  const overall = document.createElement("small");
  overall.textContent = `/ ${formatNumber(total)}`;
  summary.append(current, overall);
  return summary;
}

function revealActiveFilter(filterStrip, button) {
  if (!button || typeof globalThis.requestAnimationFrame !== "function") return;
  globalThis.requestAnimationFrame(() => {
    if (!filterStrip.isConnected || !button.isConnected) return;
    const stripRect = filterStrip.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const centerOffset = (stripRect.width - buttonRect.width) / 2;
    filterStrip.scrollLeft = Math.max(0, filterStrip.scrollLeft + buttonRect.left - stripRect.left - centerOffset);
  });
}
