import { formatNumber } from "../../../../js/format.js";
import { openFanhaoSheet } from "../../sheet.js?v=assets-07b744082137";

export function mountSearchResultToolbar(options = {}) {
  const data = options.data || {};
  const listState = options.listState;
  if (!options.container || !listState) return null;
  options.container.classList.add("has-result-toolbar");
  const toolbar = createSearchResultToolbar({
    filterMode: listState.getFilterMode(),
    filterOptions: listState.getFilterOptions(options.works, data.facets),
    sortMode: listState.getSortMode(),
    sortOptions: listState.getSortOptions(),
    onFilterChange: (value) => listState.setFilterMode(value, { replace: true }),
    onSortChange: (value) => listState.setSortMode(value)
  });
  options.container.append(toolbar);
  return toolbar;
}

export function createSearchResultToolbar(options = {}) {
  const filterOptions = normalizeOptions(options.filterOptions);
  const sortOptions = normalizeOptions(options.sortOptions);
  const filterMode = String(options.filterMode || "all");
  const sortMode = String(options.sortMode || "updated");
  const toolbar = document.createElement("nav");
  toolbar.className = "fanhao-search-result-toolbar";
  toolbar.setAttribute("aria-label", "搜索结果筛选和排序");

  toolbar.append(
    createToolbarButton("筛选", activeFilterLabel(filterMode, filterOptions), () => {
      openFanhaoSheet({
        title: "结果筛选",
        value: singleFilterValue(filterMode),
        options: filterOptions
          .filter((option) => option.value === "all" || option.value === filterMode || option.count > 0)
          .map((option) => ({
            value: option.value,
            label: `${option.label} · ${formatNumber(option.count)}`,
            select: () => options.onFilterChange?.(option.value)
          }))
      });
    }),
    createToolbarButton("排序", activeOptionLabel(sortMode, sortOptions, "最近更新"), () => {
      openFanhaoSheet({
        title: "结果排序",
        value: sortMode,
        options: sortOptions.map((option) => ({
          value: option.value,
          label: option.label,
          select: () => options.onSortChange?.(option.value)
        }))
      });
    })
  );
  return toolbar;
}

function createToolbarButton(label, value, open) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", `${label}，当前${value}`);
  const title = document.createElement("span");
  title.textContent = label;
  const current = document.createElement("strong");
  current.textContent = value;
  button.append(title, current);
  button.addEventListener("click", open);
  return button;
}

function activeFilterLabel(value, options) {
  const filters = String(value || "all").split(",").map((item) => item.trim()).filter((item) => item && item !== "all");
  if (filters.length > 1) return `${formatNumber(filters.length)} 项`;
  return activeOptionLabel(filters[0] || "all", options, "全部");
}

function singleFilterValue(value) {
  const filters = String(value || "all").split(",").map((item) => item.trim()).filter((item) => item && item !== "all");
  return filters.length === 1 ? filters[0] : "all";
}

function activeOptionLabel(value, options, fallback) {
  return options.find((option) => option.value === value)?.label || fallback;
}

function normalizeOptions(options) {
  return (Array.isArray(options) ? options : [])
    .filter((option) => option?.value && option?.label)
    .map((option) => ({ ...option, count: Math.max(0, Number(option.count || 0)) }));
}
