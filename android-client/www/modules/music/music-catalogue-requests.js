export function createMusicCatalogueRequests({
  fetchJson,
  getActiveUrl,
  isActive,
  state,
  selectedSmartPlaylist,
  selectedPlaylist,
  refreshMusicCatalogueUi
}) {
  const generations = { smart: 0, playlists: 0 };

  async function load(kind, renderGuard) {
    if (!isActive() || (renderGuard && !renderGuard())) return;
    const generation = ++generations[kind];
    const activeUrl = getActiveUrl();
    const isCurrent = () => isActive()
      && generations[kind] === generation
      && getActiveUrl() === activeUrl
      && (!renderGuard || renderGuard());
    try {
      const data = await fetchJson(activeUrl, kind === "smart" ? "/api/music/smart-playlists" : "/api/music/playlists", {
        timeoutMs: 12000,
        signal: renderGuard?.signal
      });
      if (!isCurrent()) return;
      if (kind === "smart") {
        state.smartPlaylists = Array.isArray(data.smartPlaylists) ? data.smartPlaylists : [];
        state.summary = data.summary || state.summary;
        state.smartPlaylist = selectedSmartPlaylist();
      } else {
        state.playlists = Array.isArray(data.playlists) ? data.playlists : [];
        state.playlist = selectedPlaylist();
      }
    } catch {
      if (!isCurrent()) return;
      if (kind === "smart") {
        state.smartPlaylists = [];
        state.smartPlaylist = null;
      } else {
        state.playlists = [];
        state.playlist = null;
      }
    }
    refreshMusicCatalogueUi(kind);
  }

  return {
    loadSmartPlaylists: (renderGuard = null) => load("smart", renderGuard),
    loadPlaylists: (renderGuard = null) => load("playlists", renderGuard)
  };
}
