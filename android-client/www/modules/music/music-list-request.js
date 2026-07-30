export function createMusicListRequestBuilder(deps) {
  const {
    autoCollectionLimit,
    defaultLimit,
    defaultSort,
    state
  } = deps;

  function musicListPath() {
    if (state.mode === "history") return `/api/music/history?limit=${autoCollectionLimit}`;
    if (state.mode === "playlist" && state.playlistId) {
      return `/api/music/playlists/${encodeURIComponent(state.playlistId)}`;
    }
    const query = musicListQuery();
    const resource = state.mode === "artists"
      ? "/api/music/artists"
      : state.mode === "albums"
        ? "/api/music/albums"
        : "/api/music/tracks";
    return `${resource}?${query}`;
  }

  function musicListQuery() {
    const params = new URLSearchParams();
    params.set("limit", String(state.smartId ? autoCollectionLimit : defaultLimit));
    if (state.query) params.set("q", state.query);
    if (state.mode === "artists") {
      params.set("sort", state.artistSort);
      if (state.language) params.set("language", state.language);
      return params.toString();
    }
    if (state.mode === "albums") {
      params.set("sort", state.albumSort);
      if (state.language) params.set("language", state.language);
      return params.toString();
    }
    if (state.sort && state.sort !== defaultSort && state.mode !== "smart") params.set("sort", state.sort);
    if (state.favorite) params.set("favorite", "1");
    if (state.query && state.searchFavorite) params.set("favorite", "1");
    if (state.query && state.searchLyrics) params.set("lyrics", "1");
    if (state.query && state.searchMinRating) params.set("minRating", String(state.searchMinRating));
    if (state.query && state.searchQuality) params.set("quality", state.searchQuality);
    if (state.smartId) params.set("smart", state.smartId);
    if (state.playlistId) params.set("playlist", state.playlistId);
    if (state.artistId) params.set("artist", state.artistId);
    if (state.albumId) params.set("album", state.albumId);
    if (state.genre) params.set("genre", state.genre);
    if (state.language) params.set("language", state.language);
    return params.toString();
  }

  return { musicListPath, musicListQuery };
}
