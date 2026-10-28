import { DEFAULT_SORT, normalizeSearchTab, normalizeSource } from "./shared.js?v=assets-22080e82f167";

const SEARCH_HISTORY_KEY = "fanhao.shortVideo.searchHistory";
const SEARCH_HISTORY_LIMIT = 8;
const SEARCH_SUGGESTION_LIMIT = 8;

export function createShortVideoSearch(context = {}) {
  const { api, getActiveUrl, listState } = context;
  const updateListParams = (...args) => context.updateListParams(...args);
  let suggestionRequestId = 0;
  let suggestionController = null;

  function cancelSearchSuggestions() {
    suggestionRequestId += 1;
    suggestionController?.abort();
    suggestionController = null;
  }

  function readSearchHistory() {
    try {
      const value = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]");
      return Array.isArray(value) ? value.map(normalizeQuery).filter(Boolean).slice(0, SEARCH_HISTORY_LIMIT) : [];
    } catch {
      return [];
    }
  }

  function rememberSearch(query) {
    const normalized = normalizeQuery(query);
    if (!normalized) return readSearchHistory();
    const next = [normalized, ...readSearchHistory().filter((item) => item.toLocaleLowerCase("zh-CN") !== normalized.toLocaleLowerCase("zh-CN"))]
      .slice(0, SEARCH_HISTORY_LIMIT);
    try {
      localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
    } catch {}
    return next;
  }

  function clearSearchHistory() {
    try {
      localStorage.removeItem(SEARCH_HISTORY_KEY);
    } catch {}
  }

  async function fetchSearchSuggestions(query) {
    cancelSearchSuggestions();
    const normalized = normalizeQuery(query);
    const requestId = suggestionRequestId;
    if (!normalized) return { query: "", suggestions: [] };
    const baseUrl = getActiveUrl();
    const controller = new AbortController();
    suggestionController = controller;
    const isCurrent = () => requestId === suggestionRequestId && suggestionController === controller
      && !controller.signal.aborted && baseUrl === getActiveUrl();
    const params = new URLSearchParams({ q: normalized, limit: String(SEARCH_SUGGESTION_LIMIT) });
    try {
      const result = await api.fetch(baseUrl, `/api/short-videos/suggestions?${params}`, {
        timeoutMs: 8000, signal: controller.signal
      });
      return isCurrent() ? result : null;
    } catch (error) {
      if (!isCurrent()) return null;
      throw error;
    } finally {
      if (suggestionController === controller) suggestionController = null;
    }
  }

  function submitSearch(query = "", options = {}) {
    const normalized = normalizeQuery(query);
    const searchTab = normalizeSearchTab(options.searchTab || options.tab || listState.searchTab);
    const currentSource = normalizeSource(options.source || listState.source);
    const authorSource = ["following", "authors"].includes(currentSource) ? currentSource : "authors";
    if (normalized && options.remember !== false) rememberSearch(normalized);
    updateListParams({
      query: normalized,
      author: "all",
      source: searchTab === "authors" ? authorSource : "all",
      searchTab,
      sort: options.sort || listState.sort || DEFAULT_SORT
    });
  }

  return {
    cancelSearchSuggestions,
    clearSearchHistory,
    fetchSearchSuggestions,
    readSearchHistory,
    rememberSearch,
    submitSearch
  };
}

function normalizeQuery(value) {
  return Array.from(String(value || "").trim()).slice(0, 120).join("");
}
