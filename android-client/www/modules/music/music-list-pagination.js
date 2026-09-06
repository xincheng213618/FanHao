export function createMusicListPagination(deps) {
  const { state, getActiveUrl, isActive, musicListQuery, fetchJson, collapseDuplicateTracks, render } = deps;
  let pendingController = null;

  function cancelPending() {
    const controller = pendingController;
    pendingController = null;
    controller?.abort();
    state.loadingMore = false;
  }

  async function loadMoreTracks() {
    if (!isActive() || state.loading || state.loadingMore || !state.hasMore || !state.data
      || !["library", "artists", "albums", "smart"].includes(state.mode)) return;
    const controller = new AbortController();
    const activeUrl = getActiveUrl();
    const mode = state.mode;
    const query = state.query;
    const searchScope = state.searchScope;
    const listQuery = musicListQuery();
    const sourceData = state.data;
    const isCurrent = () => pendingController === controller
      && !controller.signal.aborted
      && isActive()
      && getActiveUrl() === activeUrl
      && state.mode === mode
      && state.query === query
      && state.searchScope === searchScope
      && musicListQuery() === listQuery;
    let applied = false;
    pendingController = controller;
    state.loadingMore = true;
    render();
    try {
      const params = new URLSearchParams(listQuery);
      params.set("offset", String(mode === "artists"
        ? sourceData.artists?.length || 0
        : mode === "albums"
          ? sourceData.albums?.length || 0
          : sourceData.rawLoaded ?? sourceData.tracks?.length ?? 0));
      const endpoint = mode === "artists" ? "/api/music/artists" : mode === "albums" ? "/api/music/albums" : "/api/music/tracks";
      const data = await fetchJson(activeUrl, `${endpoint}?${params}`, { timeoutMs: 18000, signal: controller.signal });
      // Abort is best-effort: a completed response can still settle after navigation.
      if (!isCurrent() || state.data !== sourceData) return;
      if (mode === "artists") {
        state.data = { ...data, artists: [...(sourceData.artists || []), ...(data.artists || [])] };
      } else if (mode === "albums") {
        state.data = { ...data, albums: [...(sourceData.albums || []), ...(data.albums || [])] };
      } else {
        const rawTracks = [...(sourceData.rawTracks || sourceData.tracks || []), ...(data.tracks || [])];
        const tracks = mode === "library" && query ? collapseDuplicateTracks(rawTracks) : rawTracks;
        state.data = { ...data, tracks, rawTracks, rawLoaded: rawTracks.length };
        if (!query) state.queue = tracks;
      }
      state.summary = data.summary || state.summary;
      state.hasMore = Boolean(data.hasMore);
      applied = true;
    } catch (error) {
      if (isCurrent() && state.data === sourceData) throw error;
    } finally {
      // A cancelled request must not clear a newer page's loading indicator.
      if (pendingController === controller) {
        const shouldRender = isCurrent() && (applied || state.data === sourceData);
        pendingController = null;
        state.loadingMore = false;
        if (shouldRender) render();
      }
    }
  }

  return { cancelPending, loadMoreTracks };
}
