import { fetchJson } from "../../js/api.js?v=20260708-mobile-music-36";
import { formatNumber } from "../../js/format.js";
import { buildTrackVersionGroups } from "./track-versions.js?v=20260713-music-search-versions-01";
import { writeSearchHistoryPreference } from "./music-state.js?v=20260716-music-state-01";

const SEARCH_DEBOUNCE_MS = 280;
const SEARCH_SUGGESTION_DEBOUNCE_MS = 90;
const SEARCH_HISTORY_LIMIT = 8;

export function createMusicSearchController(dependencies) {
  const {
    abortMountedSearch,
    activateSearchSuggestion,
    els,
    getActiveUrl,
    normalizeSearchComparison,
    refreshMountedSearchResults,
    refreshMountedSearchSuggestions,
    refreshMountedSearchUi,
    searchPlaylistMatches,
    state,
    updateListParams
  } = dependencies;

  let searchDebounceTimer = 0;
  let searchSuggestionTimer = 0;
  let searchSuggestionController = null;

  function closeSearch() {
    disposePendingWork();
    abortMountedSearch();
    state.searchSuggestions = [];
    state.searchSuggestionQuery = "";
    state.searchSuggestionIndex = -1;
    state.searchSuggestionLoading = false;
    state.searchOpen = false;
    state.searchScope = "all";
    updateListParams({
      mode: "library",
      query: "",
      favorite: false,
      artistId: "",
      albumId: ""
    }, { resetSearch: true });
  }

  function scheduleLiveSearch(value) {
    window.clearTimeout(searchDebounceTimer);
    const query = String(value || "").trim();
    const clear = els.viewContent?.querySelector(".music-mobile-search-clear");
    if (clear) clear.hidden = !query;
    scheduleSearchSuggestions(query);
    searchDebounceTimer = window.setTimeout(() => commitMusicSearch(query, { preserveSuggestions: true }), SEARCH_DEBOUNCE_MS);
  }

  function commitMusicSearch(value, options = {}) {
    window.clearTimeout(searchDebounceTimer);
    if (!options.preserveSuggestions) {
      window.clearTimeout(searchSuggestionTimer);
      searchSuggestionController?.abort();
    }
    const query = String(value || "").trim();
    if (options.remember && query) rememberSearchQuery(query);
    if (options.remember) {
      const input = els.viewContent?.querySelector(".music-mobile-search-input");
      if (input && input.value !== query) input.value = query;
    }
    state.searchOpen = true;
    state.mode = ["artists", "albums"].includes(state.mode) ? state.mode : "library";
    state.searchScope = state.mode === "artists" ? "artists" : state.mode === "albums" ? "albums" : state.searchScope;
    state.favorite = false;
    state.artistId = "";
    state.albumId = "";
    state.genre = "";
    state.language = "";
    state.searchSuggestionQuery = query;
    refreshMountedSearchResults(query).catch(() => {});
  }

  function scheduleSearchSuggestions(value) {
    window.clearTimeout(searchSuggestionTimer);
    searchSuggestionController?.abort();
    const query = String(value || "").trim();
    state.searchSuggestionQuery = query;
    state.searchSuggestionIndex = -1;
    if (!query) {
      state.searchSuggestions = [];
      state.searchSuggestionLoading = false;
      refreshMountedSearchSuggestions();
      return;
    }
    state.searchSuggestions = [];
    state.searchSuggestionLoading = true;
    refreshMountedSearchSuggestions();
    searchSuggestionTimer = window.setTimeout(() => loadSearchSuggestions(query).catch(() => {}), SEARCH_SUGGESTION_DEBOUNCE_MS);
  }

  async function loadSearchSuggestions(query) {
    const controller = new AbortController();
    searchSuggestionController = controller;
    const params = new URLSearchParams({ q: query });
    try {
      const data = await fetchJson(getActiveUrl(), `/api/music/suggest?${params}`, { timeoutMs: 8000, signal: controller.signal });
      if (controller.signal.aborted || state.searchSuggestionQuery !== query) return;
      state.searchSuggestions = buildSearchSuggestions(query, data);
      state.searchSuggestionLoading = false;
      refreshMountedSearchSuggestions();
    } catch {
      if (controller.signal.aborted || state.searchSuggestionQuery !== query) return;
      state.searchSuggestions = buildSearchSuggestions(query, null);
      state.searchSuggestionLoading = false;
      refreshMountedSearchSuggestions();
    }
  }

  function handleSearchSuggestionKeydown(event, input) {
    const suggestions = state.searchSuggestions || [];
    if (["ArrowDown", "ArrowUp"].includes(event.key) && suggestions.length) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const current = Number(state.searchSuggestionIndex);
      state.searchSuggestionIndex = current < 0
        ? (direction > 0 ? 0 : suggestions.length - 1)
        : (current + direction + suggestions.length) % suggestions.length;
      refreshMountedSearchSuggestions();
      return;
    }
    if (event.key === "Escape" && (suggestions.length || state.searchSuggestionLoading)) {
      event.preventDefault();
      event.stopPropagation();
      searchSuggestionController?.abort();
      state.searchSuggestions = [];
      state.searchSuggestionIndex = -1;
      state.searchSuggestionLoading = false;
      refreshMountedSearchSuggestions();
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const selected = suggestions[state.searchSuggestionIndex];
    if (selected) {
      activateSearchSuggestion(selected);
      return;
    }
    state.searchSuggestions = [];
    state.searchSuggestionIndex = -1;
    state.searchSuggestionLoading = false;
    commitMusicSearch(input.value, { remember: true });
  }

  function buildSearchSuggestions(query, data) {
    const value = String(query || "").trim();
    if (!value) return [];
    const normalized = normalizeSearchComparison(value);
    const action = {
      group: "search",
      groupLabel: "搜索",
      type: "全部",
      value,
      label: `搜索“${value}”`,
      meta: "查看歌曲、歌词、歌手、专辑和歌单",
      highlights: [value],
      score: Number.MAX_SAFE_INTEGER
    };
    if (!data) return [action];

    const result = [action];
    const seenValues = new Set();
    const correctionTarget = searchSuggestionCorrectionTarget(data);
    if (data.correctedQuery && correctionTarget && normalizeSearchComparison(correctionTarget) !== normalized) {
      seenValues.add(normalizeSearchComparison(correctionTarget));
      result.push({
        group: "correction",
        groupLabel: "猜你想搜",
        type: "纠错",
        value: correctionTarget,
        label: correctionTarget,
        meta: `已识别“${value}”的相近结果`,
        highlights: [],
        score: Number.MAX_SAFE_INTEGER - 1
      });
    }

    const historyItems = (state.searchHistory || [])
      .filter((item) => {
        const itemValue = normalizeSearchComparison(item);
        return itemValue && itemValue !== normalized && (itemValue.includes(normalized) || normalized.includes(itemValue));
      })
      .slice(0, 2)
      .map((item) => ({
        group: "history",
        groupLabel: "最近搜索",
        type: "历史",
        value: item,
        meta: "再次搜索",
        highlights: [],
        score: 700 + Number(normalizeSearchComparison(item).startsWith(normalized)) * 300
      }));

    const entityGroups = [
      buildArtistSuggestionGroup(value, data.artists || [], seenValues),
      buildTrackSuggestionGroup(value, data.tracks || [], seenValues),
      buildAlbumSuggestionGroup(value, data.albums || [], seenValues),
      buildPlaylistSuggestionGroup(value, seenValues),
      suggestionGroupResult(historyItems, 4)
    ].filter((group) => group.items.length);
    entityGroups.sort((left, right) => right.score - left.score || left.priority - right.priority);
    let remaining = 8;
    for (const group of entityGroups) {
      const items = group.items.slice(0, remaining);
      result.push(...items);
      remaining -= items.length;
      if (remaining <= 0) break;
    }
    return result;
  }

  function searchSuggestionCorrectionTarget(data) {
    return String(data?.artists?.[0]?.name || buildTrackVersionGroups(data?.tracks || [])[0]?.baseTitle || data?.albums?.[0]?.title || data?.correctedQuery || "").trim();
  }

  function buildArtistSuggestionGroup(query, artists, seenValues) {
    const items = [];
    for (const artist of artists.slice(0, 3)) {
      const value = String(artist.name || "").trim();
      const key = normalizeSearchComparison(value);
      if (!value || seenValues.has(key)) continue;
      seenValues.add(key);
      items.push({
        group: "artists",
        groupLabel: "歌手",
        type: "歌手",
        value,
        meta: `${formatNumber(artist.trackCount || 0)} 首 · ${formatNumber(artist.albumCount || 0)} 专辑`,
        highlights: artist.searchMatch?.highlights?.name || [],
        score: searchSuggestionIntentScore(value, artist.searchMatch, "name", query)
      });
    }
    return suggestionGroupResult(items, 1);
  }

  function buildTrackSuggestionGroup(query, tracks, seenValues) {
    const items = [];
    for (const group of buildTrackVersionGroups(tracks).slice(0, 5)) {
      const best = [...(group.tracks || [])].sort((left, right) => searchSuggestionIntentScore(right.title, right.searchMatch, "title", query) - searchSuggestionIntentScore(left.title, left.searchMatch, "title", query))[0] || group.primary;
      const value = String(group.baseTitle || best?.title || "").trim();
      const key = normalizeSearchComparison(value);
      if (!value || seenValues.has(key)) continue;
      seenValues.add(key);
      items.push({
        group: "tracks",
        groupLabel: "歌曲",
        type: "歌曲",
        value,
        meta: [best?.artist || group.artist || "未知歌手", group.tracks.length > 1 ? `${formatNumber(group.tracks.length)} 个版本` : best?.album || "未知专辑"].filter(Boolean).join(" · "),
        highlights: best?.searchMatch?.highlights?.title || [],
        score: searchSuggestionIntentScore(value, best?.searchMatch, "title", query)
      });
    }
    return suggestionGroupResult(items, 0);
  }

  function buildAlbumSuggestionGroup(query, albums, seenValues) {
    const items = [];
    for (const album of albums.filter((item) => String(item.title || "").trim() !== "_单曲").slice(0, 3)) {
      const value = String(album.title || "").trim();
      const key = normalizeSearchComparison(value);
      if (!value || seenValues.has(key)) continue;
      seenValues.add(key);
      items.push({
        group: "albums",
        groupLabel: "专辑",
        type: "专辑",
        value,
        meta: album.artistName || "未知歌手",
        highlights: album.searchMatch?.highlights?.title || [],
        score: searchSuggestionIntentScore(value, album.searchMatch, "title", query)
      });
    }
    return suggestionGroupResult(items, 2);
  }

  function buildPlaylistSuggestionGroup(query, seenValues) {
    const items = [];
    for (const match of searchPlaylistMatches(query).slice(0, 3)) {
      const value = String(match.item?.name || "").trim();
      const key = normalizeSearchComparison(value);
      if (!value || seenValues.has(key)) continue;
      seenValues.add(key);
      items.push({
        group: "playlists",
        groupLabel: "歌单",
        type: match.kind === "smart" ? "智能歌单" : "歌单",
        value,
        meta: `${formatNumber(match.item?.trackCount || 0)} 首 · ${match.item?.description || (match.kind === "smart" ? "自动更新" : "我的歌单")}`,
        highlights: [query],
        score: match.score
      });
    }
    return suggestionGroupResult(items, 3);
  }

  function suggestionGroupResult(items, priority) {
    items.sort((left, right) => right.score - left.score);
    return { items, priority, score: Math.max(0, ...items.map((item) => item.score)) };
  }

  function searchSuggestionIntentScore(value, match, field, query) {
    const source = normalizeSearchComparison(value);
    const needle = normalizeSearchComparison(query);
    const direct = source === needle ? 10000 : source.startsWith(needle) ? 4000 : source.includes(needle) ? 2000 : 0;
    const fieldBoost = match?.field === field ? 600 : 0;
    return direct + fieldBoost + Number(match?.scores?.[field] || match?.score || 0);
  }

  function rememberSearchQuery(query) {
    const value = String(query || "").trim();
    if (!value) return;
    state.searchHistory = [value, ...state.searchHistory.filter((item) => item.toLocaleLowerCase() !== value.toLocaleLowerCase())]
      .slice(0, SEARCH_HISTORY_LIMIT);
    writeSearchHistoryPreference(state.searchHistory);
  }

  function clearSearchHistory() {
    state.searchHistory = [];
    writeSearchHistoryPreference([]);
    refreshMountedSearchUi();
  }

  function removeSearchHistoryQuery(query) {
    const value = String(query || "").trim().toLocaleLowerCase();
    state.searchHistory = state.searchHistory.filter((item) => item.toLocaleLowerCase() !== value);
    writeSearchHistoryPreference(state.searchHistory);
    refreshMountedSearchUi();
  }

  function disposePendingWork() {
    window.clearTimeout(searchDebounceTimer);
    window.clearTimeout(searchSuggestionTimer);
    searchSuggestionController?.abort();
  }

  return Object.freeze({
    clearSearchHistory,
    closeSearch,
    commitMusicSearch,
    disposePendingWork,
    handleSearchSuggestionKeydown,
    rememberSearchQuery,
    removeSearchHistoryQuery,
    scheduleLiveSearch,
    scheduleSearchSuggestions
  });
}
