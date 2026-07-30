import { formatNumber } from "../../../../js/format.js";
import { openFanhaoSheet } from "../../sheet.js?v=20260731-mobile-action-sheet-01";

export function createPersonDetailWorkToolbar(options = {}) {
  const filterOptions = normalizeOptions(options.filterOptions);
  const yearOptions = normalizeOptions(options.yearOptions);
  const sortOptions = normalizeOptions(options.sortOptions);
  const filterMode = String(options.filterMode || "all");
  const yearMode = String(options.yearMode || "all");
  const sortMode = String(options.sortMode || "updated");
  const toolbar = document.createElement("nav");
  toolbar.className = "person-detail-work-toolbar";
  toolbar.setAttribute("aria-label", "演员作品筛选、年份和排序");

  toolbar.append(
    createToolbarButton("筛选", activeFilterLabel(filterMode, filterOptions), () => {
      openFanhaoSheet({
        title: "作品筛选",
        value: singleFilterValue(filterMode),
        options: filterOptions.map((option) => ({
          value: option.value,
          label: `${option.label} · ${formatNumber(option.count || 0)}`,
          select: () => options.onFilterChange?.(option.value)
        }))
      });
    }),
    createToolbarButton("年份", activeOptionLabel(yearMode, yearOptions, "全部年份"), () => {
      openFanhaoSheet({
        title: "发行年份",
        value: yearMode,
        options: yearOptions.map((option) => ({
          value: option.value,
          label: `${option.label} · ${formatNumber(option.count || 0)}`,
          select: () => options.onYearChange?.(option.value)
        }))
      });
    }),
    createToolbarButton("排序", activeOptionLabel(sortMode, sortOptions, "最近更新"), () => {
      openFanhaoSheet({
        title: "作品排序",
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
  return (Array.isArray(options) ? options : []).filter((option) => option?.value && option?.label);
}
