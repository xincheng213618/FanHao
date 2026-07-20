const SEARCH_HISTORY_STORAGE_KEY = "fanhao.android.searchHistory";
const DEFAULT_SEARCH_TERMS = Object.freeze(["[A]"]);
const MAX_SEARCH_HISTORY = 8;

export function createFanhaoSearchPage({ els, goBack, showView, warmSearch }) {
  let prepareTimer = 0;

  function render(query = "") {
    const text = cleanQuery(query);
    window.clearTimeout(prepareTimer);
    els.viewContent.className = "content-list fanhao-search-page-content";
    const head = document.createElement("header");
    head.className = "fanhao-search-page-head";
    const form = document.createElement("form");
    form.className = "fanhao-search-page-form";
    form.setAttribute("role", "search");

    const back = document.createElement("button");
    back.type = "button";
    back.className = "fanhao-search-page-back";
    back.setAttribute("aria-label", "返回番号");
    back.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 5-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    back.addEventListener("click", goBack);

    const field = document.createElement("label");
    field.className = "fanhao-search-page-field";
    field.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const input = document.createElement("input");
    input.type = "search";
    input.autocomplete = "off";
    input.enterKeyHint = "search";
    input.placeholder = "搜番号、作品、作者";
    input.value = text;
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "fanhao-search-page-clear";
    clear.setAttribute("aria-label", "清空搜索");
    clear.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor" opacity=".16"/><path d="m9 9 6 6m0-6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const syncClear = () => { clear.hidden = !input.value; };
    syncClear();
    field.append(input, clear);

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "fanhao-search-page-submit";
    submit.textContent = "搜索";
    form.append(back, field, submit);
    head.append(form);

    const results = document.createElement("div");
    results.className = "fanhao-search-results";
    els.viewContent.replaceChildren(head, results);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitQuery(input.value);
    });
    input.addEventListener("input", () => {
      syncClear();
      window.clearTimeout(prepareTimer);
      const next = cleanQuery(input.value);
      if (!next || globalThis.navigator?.connection?.saveData) return;
      prepareTimer = window.setTimeout(() => Promise.resolve(warmSearch(next)).catch(() => {}), 180);
    });
    clear.addEventListener("click", () => {
      input.value = "";
      syncClear();
      input.focus({ preventScroll: true });
      if (text) submitQuery("", { remember: false });
    });

    if (!text) {
      renderLanding(results);
      window.requestAnimationFrame(() => {
        if (!input.isConnected) return;
        input.focus({ preventScroll: true });
      });
    }
    return { input, results };
  }

  function renderLanding(container) {
    const landing = document.createElement("section");
    landing.className = "fanhao-search-landing";
    const historyHead = document.createElement("div");
    historyHead.className = "fanhao-search-history-head";
    const title = document.createElement("strong");
    title.textContent = "搜索历史";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "清空";
    clear.addEventListener("click", () => {
      localStorage.removeItem(SEARCH_HISTORY_STORAGE_KEY);
      landing.replaceWith(createLanding());
    });
    historyHead.append(title, clear);
    const chips = document.createElement("div");
    chips.className = "fanhao-search-history-chips";
    for (const item of searchTerms()) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = item;
      chip.addEventListener("click", () => submitQuery(item));
      chips.append(chip);
    }
    const prompt = document.createElement("div");
    prompt.className = "fanhao-search-prompt";
    prompt.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><strong>搜索番号资料库</strong><span>支持番号、作品标题、文件名和作者</span>';
    landing.append(historyHead, chips, prompt);
    container.append(landing);

    function createLanding() {
      const next = document.createElement("div");
      renderLanding(next);
      return next.firstElementChild;
    }
  }

  function submitQuery(value, options = {}) {
    const query = cleanQuery(value);
    if (query && options.remember !== false) rememberSearch(query);
    if (query) Promise.resolve(warmSearch(query)).catch(() => {});
    showView("search", { query }, { skipHistory: true, replaceHistory: true });
  }

  return { render, submitQuery };
}

function searchTerms() {
  const recent = readSearchHistory();
  const defaultKeys = new Set(DEFAULT_SEARCH_TERMS.map((item) => item.toLocaleLowerCase("zh-CN")));
  return [...DEFAULT_SEARCH_TERMS, ...recent.filter((item) => !defaultKeys.has(item.toLocaleLowerCase("zh-CN")))];
}

function readSearchHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? uniqueQueries(parsed).slice(0, MAX_SEARCH_HISTORY) : [];
  } catch {
    return [];
  }
}

function rememberSearch(value) {
  const query = cleanQuery(value);
  if (!query) return;
  const key = query.toLocaleLowerCase("zh-CN");
  const next = [query, ...readSearchHistory().filter((item) => item.toLocaleLowerCase("zh-CN") !== key)]
    .slice(0, MAX_SEARCH_HISTORY);
  localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
}

function uniqueQueries(values) {
  const seen = new Set();
  const items = [];
  for (const value of values) {
    const query = cleanQuery(value);
    const key = query.toLocaleLowerCase("zh-CN");
    if (!query || seen.has(key)) continue;
    seen.add(key);
    items.push(query);
  }
  return items;
}

function cleanQuery(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}
