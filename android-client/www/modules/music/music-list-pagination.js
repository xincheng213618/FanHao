export function createMusicListPagination(deps) {
  const { state, getActiveUrl, isActive, musicListQuery, fetchJson, collapseDuplicateTracks, render, setLoadingState, appendPage } = deps;
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
    let incomingData = null;
    pendingController = controller;
    state.loadingMore = true;
    if (!setLoadingState?.(true)) render();
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
      incomingData = data;
      if (mode === "artists") {
        state.data = { ...data, artists: [...(sourceData.artists || []), ...(data.artists || [])] };
      } else if (mode === "albums") {
        state.data = { ...data, albums: [...(sourceData.albums || []), ...(data.albums || [])] };
      } else {
        const rawTracks = [...(sourceData.rawTracks || sourceData.tracks || []), ...(data.tracks || [])];
        const tracks = mode === "library" && query ? collapseDuplicateTracks(rawTracks) : mergeTracksById(sourceData.tracks || [], data.tracks || []);
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
        if (shouldRender) {
          const appended = applied && appendPage?.({ mode, sourceData, data: state.data, incomingData });
          const resetLoading = !applied && setLoadingState?.(false);
          if (!appended && !resetLoading) render();
        }
      }
    }
  }

  return { cancelPending, loadMoreTracks };
}

function mergeTracksById(previous, incoming) {
  const tracks = [], positions = new Map();
  for (const track of [...previous, ...incoming]) {
    const position = positions.get(track.id);
    if (position === undefined) {
      positions.set(track.id, tracks.length);
      tracks.push(track);
    } else tracks[position] = track;
  }
  return tracks;
}
