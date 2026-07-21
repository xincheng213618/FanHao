import { formatNumber } from "../../../../js/format.js";
import { CATEGORY_OPTIONS } from "../categories/category-views.js?v=20260721-fanhao-category-browser-13";
import { openFanhaoSheet } from "../../sheet.js?v=20260721-fanhao-person-detail-02";

const ALL_CATEGORY = Object.freeze({ value: "all", label: "全部" });

export function mountSearchResultToolbar(options = {}) {
  const data = options.data || {};
  const listState = options.listState;
  if (!options.container || !listState) return null;
  const categories = Array.isArray(data.categories) ? data.categories : [];
  options.container.classList.add("has-result-toolbar");
  const toolbar = createSearchResultToolbar({
    category: data.category || options.category,
    categories,
    total: categories.length
      ? categories.reduce((sum, item) => sum + Number(item?.count || 0), 0)
      : options.total,
    filterMode: listState.getFilterMode(),
    filterOptions: listState.getFilterOptions(options.works, data.facets),
    sortMode: listState.getSortMode(),
    sortOptions: listState.getSortOptions(),
    onCategoryChange: options.onCategoryChange,
    onFilterChange: (value) => listState.setFilterMode(value, { replace: true }),
    onSortChange: (value) => listState.setSortMode(value)
  });
  options.container.append(toolbar);
  return toolbar;
}

export function createSearchResultToolbar(options = {}) {
  const category = normalizeCategory(options.category);
  const categoryOptions = searchCategoryOptions(options.categories, options.total);
  const filterOptions = normalizeOptions(options.filterOptions);
  const sortOptions = normalizeOptions(options.sortOptions);
  const filterMode = String(options.filterMode || "all");
  const sortMode = String(options.sortMode || "updated");
  const toolbar = document.createElement("nav");
  toolbar.className = "fanhao-search-result-toolbar";
  toolbar.setAttribute("aria-label", "搜索结果类型、筛选和排序");

  toolbar.append(
    createToolbarButton("类型", activeOptionLabel(category, categoryOptions, "全部"), () => {
      openFanhaoSheet({
        title: "作品类型",
        value: category,
        options: categoryOptions.map((option) => ({
          value: option.value,
          label: `${option.label} · ${formatNumber(option.count)}`,
          select: () => options.onCategoryChange?.(option.value)
        }))
      });
    }),
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

function searchCategoryOptions(summaries = [], total = 0) {
  const counts = new Map((Array.isArray(summaries) ? summaries : []).map((item) => [
    String(item?.value || ""),
    Math.max(0, Number(item?.count || 0))
  ]));
  const categoryTotal = CATEGORY_OPTIONS.reduce((sum, option) => sum + (counts.get(option.value) || 0), 0);
  return [ALL_CATEGORY, ...CATEGORY_OPTIONS].map((option) => ({
    ...option,
    count: option.value === "all" ? Math.max(categoryTotal, Number(total || 0)) : (counts.get(option.value) || 0)
  }));
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

function normalizeCategory(value) {
  const category = String(value || "all").trim().toLowerCase();
  return category === "all" || CATEGORY_OPTIONS.some((option) => option.value === category) ? category : "all";
}
