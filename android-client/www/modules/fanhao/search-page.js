import { formatNumber } from "../../js/format.js";
import { absoluteUrl, imageUrlForWork, portraitUrlForPerson } from "../../js/image.js?v=20260721-fanhao-search-suggestions-19";
import { compactWorkCardTitle, workGridMeta, workGridPerson } from "./features/works/card-presentation.js?v=20260721-fanhao-author-sort-density-08";

const SEARCH_HISTORY_STORAGE_KEY = "fanhao.android.searchHistory";
const DEFAULT_SEARCH_TERMS = Object.freeze(["[A]"]);
const MAX_SEARCH_HISTORY = 8;
const MAX_AUTHOR_SUGGESTIONS = 12;
const MAX_LIVE_SUGGESTIONS = 6;

export function createFanhaoSearchPage({
  els,
  goBack,
  showView,
  preserveQuery = () => false,
  warmSearch,
  fetchSuggestions = async () => ({ people: [], works: [] }),
  getActiveUrl = () => "",
  getLibrary = () => null
}) {
  let prepareTimer = 0;
  let suggestionTimer = 0;
  let suggestionController = null;

  function render(query = "") {
    const text = cleanQuery(query);
    window.clearTimeout(prepareTimer);
    window.clearTimeout(suggestionTimer);
    suggestionController?.abort();
    suggestionController = null;
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
    const suggestions = document.createElement("div");
    suggestions.className = "fanhao-search-suggestions";
    suggestions.hidden = true;
    head.append(suggestions);
    els.viewContent.replaceChildren(head, results);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitQuery(input.value);
    });
    input.addEventListener("input", () => {
      syncClear();
      window.clearTimeout(prepareTimer);
      const next = cleanQuery(input.value);
      if (!next) {
        hideSuggestions();
        return;
      }
      if (!globalThis.navigator?.connection?.saveData) {
        prepareTimer = window.setTimeout(() => Promise.resolve(warmSearch(next)).catch(() => {}), 180);
      }
      requestSuggestions(next);
    });
    input.addEventListener("focus", () => requestSuggestions(input.value));
    input.addEventListener("blur", () => window.setTimeout(() => {
      if (!head.contains(document.activeElement)) hideSuggestions();
    }, 80));
    clear.addEventListener("click", () => {
      input.value = "";
      syncClear();
      hideSuggestions();
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

    function requestSuggestions(value) {
      const next = cleanQuery(value);
      window.clearTimeout(suggestionTimer);
      suggestionController?.abort();
      suggestionController = null;
      if (!next) {
        hideSuggestions();
        return;
      }
      suggestionTimer = window.setTimeout(async () => {
        const controller = new AbortController();
        suggestionController = controller;
        try {
          const data = await fetchSuggestions(next, { signal: controller.signal });
          if (controller.signal.aborted || !input.isConnected || cleanQuery(input.value) !== next) return;
          renderSuggestions(buildFanhaoSearchSuggestions(data, MAX_LIVE_SUGGESTIONS));
        } catch (error) {
          if (error?.name !== "AbortError") hideSuggestions();
        } finally {
          if (suggestionController === controller) suggestionController = null;
        }
      }, 220);
    }

    function renderSuggestions(items) {
      suggestions.replaceChildren();
      if (!items.length) {
        suggestions.hidden = true;
        return;
      }
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `fanhao-search-suggestion ${item.kind}`;
        const visual = createSuggestionVisual(item);
        const copy = document.createElement("span");
        copy.className = "fanhao-search-suggestion-copy";
        const label = document.createElement("strong");
        label.textContent = item.label;
        const detail = document.createElement("small");
        detail.textContent = item.detail;
        copy.append(label, detail);
        button.append(visual, copy, createChevron());
        button.addEventListener("pointerdown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          const query = cleanQuery(input.value);
          rememberSearch(query);
          preserveQuery(query);
          hideSuggestions();
          input.blur();
          if (item.kind === "person") {
            showView("personDetail", { personId: item.id }, { push: true });
          } else if (item.missingLocal && item.javdbUrl) {
            window.open(item.javdbUrl, "_blank", "noreferrer");
          } else {
            showView("workDetail", { workId: item.id }, { push: true });
          }
        });
        suggestions.append(button);
      }
      suggestions.hidden = false;
    }

    function hideSuggestions() {
      window.clearTimeout(suggestionTimer);
      suggestionController?.abort();
      suggestionController = null;
      suggestions.hidden = true;
    }
  }

  function renderResultOverview(container, { query = "", total = 0, people = [] } = {}) {
    const summary = document.createElement("div");
    summary.className = "fanhao-search-result-summary";
    summary.setAttribute("role", "status");
    summary.setAttribute("aria-live", "polite");
    const count = document.createElement("strong");
    count.textContent = `${formatNumber(total)} 个作品`;
    const detail = document.createElement("span");
    detail.textContent = people.length
      ? `${formatNumber(people.length)} 位演员匹配`
      : `“${cleanQuery(query)}”的搜索结果`;
    summary.append(count, detail);
    container.append(summary);

    if (!people.length) return;
    const section = document.createElement("section");
    section.className = "fanhao-search-people-section";
    const head = document.createElement("div");
    head.className = "fanhao-search-people-head";
    const title = document.createElement("strong");
    title.textContent = "相关演员";
    const note = document.createElement("span");
    note.textContent = "点选直达";
    head.append(title, note);
    const list = document.createElement("div");
    list.className = "fanhao-search-people-list";
    for (const person of people.slice(0, 12)) list.append(createPersonMatch(person));
    section.append(head, list);
    container.append(section);
  }

  function createPersonMatch(person) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fanhao-search-person-card";
    const name = displayPersonName(person);
    const visual = createVisual({
      className: "fanhao-search-person-avatar",
      fallback: initials(name),
      imageUrl: portraitUrlForPerson(person),
      person: true
    });
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = name;
    const count = document.createElement("small");
    count.textContent = `${formatNumber(person.workCount || 0)} 部本地作品`;
    copy.append(title, count);
    button.append(visual, copy, createChevron());
    button.addEventListener("click", () => showView("personDetail", { personId: person.id }, { push: true }));
    return button;
  }

  function createSuggestionVisual(item) {
    return createVisual({
      className: `fanhao-search-suggestion-visual ${item.kind}`,
      fallback: item.kind === "person" ? initials(item.label) : "作品",
      imageUrl: item.imageUrl,
      person: item.kind === "person"
    });
  }

  function createVisual({ className, fallback, imageUrl, person = false }) {
    const visual = document.createElement("span");
    visual.className = className;
    visual.textContent = fallback;
    if (!imageUrl) return visual;
    const image = document.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.loading = "lazy";
    image.src = absoluteUrl(getActiveUrl(), imageUrl);
    image.classList.toggle("person", person);
    image.addEventListener("error", () => image.remove(), { once: true });
    visual.append(image);
    return visual;
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

  return { render, renderResultOverview, submitQuery };
}

export function buildFanhaoSearchSuggestions(data = {}, limit = MAX_LIVE_SUGGESTIONS) {
  const max = Math.max(0, Number(limit) || 0);
  if (!max) return [];
  const items = [];
  const seenPeople = new Set();
  for (const person of Array.isArray(data.people) ? data.people : []) {
    const id = cleanQuery(person?.id);
    const label = displayPersonName(person);
    if (!id || !label || seenPeople.has(id)) continue;
    seenPeople.add(id);
    items.push({
      kind: "person",
      id,
      label,
      detail: `${formatNumber(person.workCount || 0)} 部本地作品`,
      imageUrl: portraitUrlForPerson(person)
    });
    if (items.length >= Math.min(2, max)) break;
  }
  const seenWorks = new Set();
  for (const work of Array.isArray(data.works) ? data.works : []) {
    const id = cleanQuery(work?.id);
    if (!id || seenWorks.has(id)) continue;
    seenWorks.add(id);
    const detail = [workGridPerson(work), workGridMeta(work)].filter(Boolean).join(" · ") || "作品";
    items.push({
      kind: "work",
      id,
      label: compactWorkCardTitle(work),
      detail,
      imageUrl: imageUrlForWork(work),
      missingLocal: Boolean(work.missingLocal),
      javdbUrl: cleanQuery(work.javdbUrl || work.infoSummary?.javdbUrl)
    });
    if (items.length >= max) break;
  }
  return items.slice(0, max);
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

function displayPersonName(person) {
  return cleanQuery(person?.actorProfile?.displayName || person?.name);
}

function initials(value) {
  return cleanQuery(value).slice(0, 2) || "?";
}

function createChevron() {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.innerHTML = '<path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
  return icon;
}
