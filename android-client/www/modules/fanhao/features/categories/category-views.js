import { cacheAgeText } from "../../../../js/cache.js?v=20260702-novel-local-manage-74";
import { formatNumber } from "../../../../js/format.js";

export const CATEGORY_OPTIONS = Object.freeze([
  { value: "censored", label: "番号" },
  { value: "western", label: "欧美" }
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
    workListState
  } = context;

  async function renderCategories(requestedCategory = "censored", isActive = () => true) {
    const category = normalizeCategory(requestedCategory);
    const label = categoryLabel(category);
    setActiveBottom("works");
    els.viewKicker.textContent = "片库";
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
      applyHeader(data, cacheEntry);
      els.viewContent.replaceChildren();
      renderWorks(works, `还没有${label}作品。`, {
        compactMeta: true,
        coverGrid: true,
        hideControls: true,
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
      filter: "all",
      sort: workListState.getServerSortMode(),
      limit: getWorksLimit()
    });
  }

  return { renderCategories };
}

function categoryLabel(value) {
  return CATEGORY_OPTIONS.find((option) => option.value === value)?.label || CATEGORY_OPTIONS[0].label;
}
