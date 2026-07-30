import { cacheAgeText } from "../../../../js/cache.js?v=20260702-novel-local-manage-74";
import { formatNumber } from "../../../../js/format.js";

export const CATEGORY_OPTIONS = Object.freeze([
  { value: "all", label: "全部" },
  { value: "censored", label: "有码" },
  { value: "western", label: "欧美" },
  { value: "fc2", label: "FC2" },
  { value: "anime", label: "动漫" }
]);

export function normalizeCategory(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return CATEGORY_OPTIONS.some((option) => option.value === normalized) ? normalized : "censored";
}

export function categoryWorksPath(category, options = {}) {
  const params = new URLSearchParams({
    category: normalizeCategory(category),
    filter: String(options.filter || "all"),
    sort: String(options.sort || "updated"),
    limit: String(options.limit || 48),
    offset: "0"
  });
  return `/api/works?${params}`;
}

export function createCategoryViews(context) {
  const {
    els,
    getActiveUrl,
    getWorksLimit,
    increaseWorksLimit,
    pageDataService,
    renderCurrentViewPreservingScroll,
    renderMessage,
    renderWorks,
    setActiveBottom,
    showView,
    workListState
  } = context;
  let categorySummaries = [];

  async function renderCategories(requestedCategory = "censored", isActive = () => true) {
    const category = normalizeCategory(requestedCategory);
    const label = categoryLabel(category);
    setActiveBottom("works");
    els.viewKicker.textContent = "分类";
    els.viewTitle.textContent = label;
    els.viewMeta.textContent = "正在加载";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载${label}作品</div>`;
    const path = requestPath(category);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const applyHeader = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || works.length);
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewTitle.textContent = label;
      els.viewMeta.textContent = `${formatNumber(works.length)} / ${formatNumber(total)} 个作品${suffix}`;
    };

    const renderData = (data, cacheEntry = null) => {
      const works = data.works || [];
      const total = Number(data.total || works.length);
      if (Array.isArray(data.categories) && data.categories.length) categorySummaries = data.categories;
      applyHeader(data, cacheEntry);
      els.viewContent.replaceChildren(createCategoryStrip(categorySummaries, category, total));
      renderWorks(works, `还没有${label}作品。`, {
        compactMeta: true,
        compactSummary: true,
        coverGrid: true,
        facets: data.facets,
        total,
        hasServerMore: works.length < total,
        onLoadMore() {
          increaseWorksLimit(48);
          return renderCurrentViewPreservingScroll();
        }
      });
    };

    try {
      const result = await pageDataService.load(activeUrl, path, {
        signal: isActive.signal,
        isActive,
        onCached(data, cacheEntry) {
          renderedCache = true;
          renderData(data, cacheEntry);
        }
      });
      if (!result || !isActive()) return;
      if (result.unchanged) applyHeader(result.data);
      else renderData(result.data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) renderMessage("电脑端暂时连不上，当前显示的是本地缓存分类。", "quiet", false);
      else renderMessage(error.message, "error");
    }
  }

  function requestPath(category) {
    return categoryWorksPath(category, {
      filter: workListState.getServerFilterMode(),
      sort: workListState.getServerSortMode(),
      limit: getWorksLimit()
    });
  }

  function createCategoryStrip(summaries = [], activeCategory, activeTotal = 0) {
    const counts = new Map((summaries || []).map((item) => [String(item.value || ""), Number(item.count || 0)]));
    const categorizedTotal = CATEGORY_OPTIONS
      .filter((option) => option.value !== "all")
      .reduce((sum, option) => sum + Number(counts.get(option.value) || 0), 0);
    counts.set("all", categorizedTotal || (activeCategory === "all" ? Number(activeTotal || 0) : 0));
    const strip = document.createElement("nav");
    strip.className = "fanhao-category-strip";
    strip.setAttribute("aria-label", "番号分类");
    for (const option of CATEGORY_OPTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      const active = option.value === activeCategory;
      button.className = active ? "active" : "";
      button.setAttribute("aria-pressed", active ? "true" : "false");
      const name = document.createElement("strong");
      name.textContent = option.label;
      const count = document.createElement("span");
      count.textContent = formatNumber(counts.get(option.value) || 0);
      button.append(name, count);
      const warm = () => pageDataService.warm(getActiveUrl(), [requestPath(option.value)]);
      button.addEventListener("pointerdown", warm, { passive: true });
      button.addEventListener("focus", warm);
      button.addEventListener("click", () => {
        if (active) return;
        showView("categories", { category: option.value }, { skipHistory: true, replaceHistory: true });
      });
      strip.append(button);
    }
    return strip;
  }

  return { renderCategories };
}

function categoryLabel(value) {
  return CATEGORY_OPTIONS.find((option) => option.value === value)?.label || CATEGORY_OPTIONS[0].label;
}
