import { cacheAgeText } from "../../../../js/cache.js?v=20260702-novel-local-manage-74";
import { formatNumber } from "../../../../js/format.js";

const PREFIX_PAGE_SIZE = 64;
const PREFIX_SORT_STORAGE_KEY = "fanhao.android.codePrefixSort";

export function normalizeCodePrefix(value) {
  return String(value || "").trim().replaceAll("_", "-").toUpperCase();
}

export function codePrefixDetailPath(prefix, options = {}) {
  const filter = String(options.filter || "all");
  const params = new URLSearchParams({
    filter,
    sort: String(options.sort || "updated"),
    limit: String(options.limit || 48),
    offset: "0",
    includeMissingLocal: filter.split(",").includes("missingLocal") ? "1" : "0"
  });
  if (options.family) params.set("family", "1");
  return `/api/code-prefixes/${encodeURIComponent(normalizeCodePrefix(prefix))}?${params}`;
}

export function createCodePrefixViews(context) {
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

  let prefixQuery = "";
  let prefixSort = readPrefixSort();
  let visibleLimit = PREFIX_PAGE_SIZE;

  async function renderIndex(isActive = () => true) {
    setActiveBottom("works");
    els.viewKicker.textContent = "番号";
    els.viewTitle.textContent = "番号前缀";
    els.viewMeta.textContent = "正在整理";
    els.viewContent.innerHTML = `<div class="loading-row">正在整理番号与厂商对应关系</div>`;
    const path = "/api/code-prefixes?sort=count";
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const renderData = (data, cacheEntry = null) => {
      const prefixes = Array.isArray(data.prefixes) ? data.prefixes : [];
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewMeta.textContent = `${formatNumber(prefixes.length)} 个前缀 · ${formatNumber(data.localWorkCount || 0)} 部本地作品${suffix}`;
      renderPrefixBrowser(prefixes, data);
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
      if (!result.unchanged) renderData(result.data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) renderMessage("电脑端暂时连不上，当前显示的是本地缓存番号索引。", "quiet", false);
      else renderMessage(error.message || "番号索引读取失败", "error");
    }
  }

  async function renderDetail(prefix, family = false, isActive = () => true) {
    const normalizedPrefix = normalizeCodePrefix(prefix);
    if (!normalizedPrefix) return renderIndex(isActive);
    setActiveBottom("works");
    els.viewKicker.textContent = "番号前缀";
    els.viewTitle.textContent = normalizedPrefix;
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在加载 ${normalizedPrefix} 作品</div>`;
    const path = detailPath(normalizedPrefix, family);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    const applyHeader = (data, cacheEntry = null) => {
      const meta = data.codePrefix || {};
      const works = data.works || [];
      const total = Number(data.total || works.length);
      const maker = meta.maker?.name || "厂商待识别";
      const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
      els.viewTitle.textContent = `${meta.prefix || normalizedPrefix}${meta.family ? " 系列" : ""}`;
      els.viewMeta.textContent = `${maker} · ${formatNumber(works.length)} / ${formatNumber(total)} 部${suffix}`;
    };

    const renderData = (data, cacheEntry = null) => {
      const meta = data.codePrefix || {};
      const works = data.works || [];
      const total = Number(data.total || works.length);
      applyHeader(data, cacheEntry);
      els.viewContent.replaceChildren(createPrefixSummary(meta, total));
      renderWorks(works, `还没有 ${normalizedPrefix} 作品。`, {
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
      if (renderedCache) renderMessage("电脑端暂时连不上，当前显示的是本地缓存前缀作品。", "quiet", false);
      else renderMessage(error.message || "番号作品读取失败", "error");
    }
  }

  function detailPath(prefix, family = false) {
    const request = workListState.getRequestState();
    return codePrefixDetailPath(prefix, {
      family,
      filter: request.filter,
      sort: request.sort,
      limit: getWorksLimit()
    });
  }

  function renderPrefixBrowser(prefixes, data) {
    const toolbar = document.createElement("section");
    toolbar.className = "code-prefix-mobile-toolbar";

    const search = document.createElement("label");
    search.className = "code-prefix-mobile-search";
    search.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const input = document.createElement("input");
    input.type = "search";
    input.autocomplete = "off";
    input.placeholder = "筛选番号或厂商";
    input.setAttribute("aria-label", "筛选番号或厂商");
    input.value = prefixQuery;
    search.append(input);

    const sort = document.createElement("div");
    sort.className = "code-prefix-mobile-sort";
    for (const [value, label] of [["count", "数量"], ["name", "番号"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.classList.toggle("active", prefixSort === value);
      button.addEventListener("click", () => {
        if (prefixSort === value) return;
        prefixSort = value;
        visibleLimit = PREFIX_PAGE_SIZE;
        localStorage.setItem(PREFIX_SORT_STORAGE_KEY, prefixSort);
        paintPrefixResults(results, prefixes, data);
      });
      sort.append(button);
    }
    toolbar.append(search, sort);

    const results = document.createElement("section");
    results.className = "code-prefix-mobile-results";
    input.addEventListener("input", () => {
      prefixQuery = input.value.trim();
      visibleLimit = PREFIX_PAGE_SIZE;
      paintPrefixResults(results, prefixes, data);
    });
    els.viewContent.replaceChildren(toolbar, results);
    paintPrefixResults(results, prefixes, data);
  }

  function paintPrefixResults(container, prefixes, data) {
    const query = prefixQuery.toLocaleUpperCase("zh-CN");
    const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
    const filtered = [...prefixes]
      .filter((item) => !query || `${item.prefix || ""} ${item.maker?.name || ""} ${(item.makers || []).map((maker) => maker.name).join(" ")}`.toLocaleUpperCase("zh-CN").includes(query))
      .sort((a, b) => prefixSort === "name"
        ? collator.compare(a.prefix, b.prefix) || Number(b.localCount || 0) - Number(a.localCount || 0)
        : Number(b.localCount || 0) - Number(a.localCount || 0) || collator.compare(a.prefix, b.prefix));
    const visible = filtered.slice(0, visibleLimit);
    container.replaceChildren();

    const summary = document.createElement("div");
    summary.className = "code-prefix-mobile-summary";
    summary.innerHTML = `<strong>${formatNumber(filtered.length)}</strong><span>个前缀</span><span>${formatNumber(data.mappedCount || 0)} 个已有厂商对应</span>`;
    container.append(summary);
    if (!visible.length) {
      renderMessageInto(container, prefixQuery ? `没有匹配“${prefixQuery}”的番号前缀。` : "还没有可识别的番号前缀。");
      return;
    }

    const list = document.createElement("div");
    list.className = "code-prefix-mobile-list";
    for (const item of visible) list.append(createPrefixCard(item));
    container.append(list);
    if (visible.length < filtered.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "code-prefix-mobile-more";
      more.textContent = `继续加载 ${formatNumber(visible.length)} / ${formatNumber(filtered.length)}`;
      more.addEventListener("click", () => {
        visibleLimit += PREFIX_PAGE_SIZE;
        paintPrefixResults(container, prefixes, data);
      });
      container.append(more);
    }
  }

  function createPrefixCard(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-prefix-mobile-card";
    const prefix = document.createElement("strong");
    prefix.textContent = item.prefix || "-";
    const maker = document.createElement("span");
    maker.textContent = item.maker?.name || "厂商待识别";
    const count = document.createElement("small");
    count.textContent = `${formatNumber(item.localCount || 0)} 部本地作品`;
    button.append(prefix, maker, count);
    const open = () => showView("codePrefixDetail", { prefix: item.prefix }, { push: true });
    const warm = () => pageDataService.warm(getActiveUrl(), [detailPath(item.prefix)]);
    button.addEventListener("pointerdown", warm, { passive: true });
    button.addEventListener("focus", warm);
    button.addEventListener("click", open);
    return button;
  }

  function createPrefixSummary(meta, total) {
    const summary = document.createElement("section");
    summary.className = "code-prefix-mobile-detail-summary";
    const title = document.createElement("strong");
    title.textContent = meta.maker?.name || "厂商待识别";
    const detail = document.createElement("span");
    const parts = [
      `${formatNumber(meta.localCount || 0)} 部本地`,
      Number(meta.missingCount || 0) ? `${formatNumber(meta.missingCount)} 部未下载` : "",
      `${formatNumber(total)} 个结果`
    ].filter(Boolean);
    detail.textContent = parts.join(" · ");
    summary.append(title, detail);
    return summary;
  }

  function renderMessageInto(container, message) {
    const box = document.createElement("div");
    box.className = "message-box quiet";
    box.textContent = message;
    container.append(box);
  }

  function readPrefixSort() {
    try {
      return localStorage.getItem(PREFIX_SORT_STORAGE_KEY) === "name" ? "name" : "count";
    } catch {
      return "count";
    }
  }

  return { renderDetail, renderIndex };
}
