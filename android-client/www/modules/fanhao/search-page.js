const SEARCH_HISTORY_STORAGE_KEY = "fanhao.android.searchHistory";
const DEFAULT_SEARCH_TERMS = Object.freeze(["[A]"]);
const MAX_SEARCH_HISTORY = 8;
const MAX_AUTHOR_SUGGESTIONS = 12;

export function createFanhaoSearchPage({ els, goBack, showView, warmSearch, getLibrary = () => null }) {
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
    input.placeholder = "搜番号、作品、演员";
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
    const defaultKeys = new Set(DEFAULT_SEARCH_TERMS.map((query) => query.toLocaleLowerCase("zh-CN")));
    const history = readSearchHistory().filter((query) => !defaultKeys.has(query.toLocaleLowerCase("zh-CN")));
    if (history.length) {
      landing.append(createSearchGroup("搜索历史", history.map((query) => ({ query, label: query })), {
        actionLabel: "清空",
        onAction() {
          localStorage.removeItem(SEARCH_HISTORY_STORAGE_KEY);
          landing.replaceWith(createLanding());
        }
      }));
    }
    landing.append(createSearchGroup("快捷搜索", DEFAULT_SEARCH_TERMS.map((query) => ({
      query,
      label: query,
      meta: "本地标记",
      remember: false
    })), { note: "直接筛选" }));
    const authors = localAuthorSearchSuggestions(getLibrary()?.people);
    if (authors.length) {
      landing.append(createSearchGroup("演员推荐", authors.map((author) => ({
        query: author.name,
        label: author.name,
        meta: `${author.workCount.toLocaleString("zh-CN")} 部`,
        onSelect: () => showView("personDetail", { personId: author.id }, { push: true })
      })), { note: "点选直达" }));
    }
    const prompt = document.createElement("div");
    prompt.className = "fanhao-search-prompt";
    prompt.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><strong>继续输入也可以搜索</strong><span>支持番号、作品标题、文件名和演员</span>';
    landing.append(prompt);
    container.append(landing);

    function createLanding() {
      const next = document.createElement("div");
      renderLanding(next);
      return next.firstElementChild;
    }

    function createSearchGroup(titleText, items, options = {}) {
      const group = document.createElement("section");
      group.className = "fanhao-search-discovery-group";
      const head = document.createElement("div");
      head.className = "fanhao-search-history-head";
      const title = document.createElement("strong");
      title.textContent = titleText;
      head.append(title);
      if (options.actionLabel && typeof options.onAction === "function") {
        const action = document.createElement("button");
        action.type = "button";
        action.textContent = options.actionLabel;
        action.addEventListener("click", options.onAction);
        head.append(action);
      } else if (options.note) {
        const note = document.createElement("span");
        note.textContent = options.note;
        head.append(note);
      }
      const chips = document.createElement("div");
      chips.className = "fanhao-search-history-chips";
      for (const item of items) {
        const chip = document.createElement("button");
        chip.type = "button";
        const label = document.createElement("span");
        label.textContent = item.label;
        chip.append(label);
        if (item.meta) {
          const meta = document.createElement("small");
          meta.textContent = item.meta;
          chip.append(meta);
        }
        chip.addEventListener("click", () => {
          if (typeof item.onSelect === "function") item.onSelect();
          else submitQuery(item.query, { remember: item.remember !== false });
        });
        chips.append(chip);
      }
      group.append(head, chips);
      return group;
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

function readSearchHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? uniqueQueries(parsed).slice(0, MAX_SEARCH_HISTORY) : [];
  } catch {
    return [];
  }
}

export function localAuthorSearchSuggestions(people = [], limit = MAX_AUTHOR_SUGGESTIONS) {
  const suggestions = new Map();
  for (const person of Array.isArray(people) ? people : []) {
    const name = cleanQuery(person?.actorProfile?.displayName);
    const key = name.toLocaleLowerCase("zh-CN");
    const id = cleanQuery(person?.id);
    const workCount = Math.max(0, Number(person?.workCount || 0));
    if (!id || !name || !workCount || person?.actorProfile?.gender === "male") continue;
    const candidate = {
      id,
      name,
      workCount,
      sourceCount: Math.max(0, Number(person?.sourceCount || 0))
    };
    const previous = suggestions.get(key);
    if (!previous || compareAuthorSuggestion(candidate, previous) < 0) suggestions.set(key, candidate);
  }
  return [...suggestions.values()]
    .sort(compareAuthorSuggestion)
    .slice(0, Math.max(0, Number(limit) || 0));
}

function compareAuthorSuggestion(a, b) {
  return b.sourceCount - a.sourceCount || b.workCount - a.workCount || a.name.localeCompare(b.name, "zh-Hans-CN");
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
