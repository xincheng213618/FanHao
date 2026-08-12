// 音乐模块纯 HTTP 客户端。
// 把 music-page.js 里散落的 api(...) 调用集中为命名方法，便于复用与单测。
// 不触碰 DOM、不持有状态；只依赖宿主注入的 api(path, options) 包装器。

/**
 * @param {(path: string, options?: object) => Promise<any>} api 宿主 fetch 包装器
 * @returns 命名 API 方法集合
 */
export function createMusicApi(api) {
  const get = (path, signal) => api(path, signal ? { signal } : undefined);
  const send = (path, method, body, signal) =>
    api(path, { method, body, ...(signal ? { signal } : {}) });

  return {
    getTracks(params, signal) {
      const qs = params instanceof URLSearchParams ? params.toString() : String(params || "");
      return get(`/api/music/tracks?${qs}`, signal);
    },
    getHome(signal) {
      const params = new URLSearchParams();
      params.set("limit", "80");
      params.set("sort", "played");
      return get(`/api/music/tracks?${params}`, signal);
    },
    getArtists(params, signal) {
      const qs = params instanceof URLSearchParams ? params.toString() : String(params || "");
      return get(`/api/music/artists?${qs}`, signal);
    },
    getAlbums(params, signal) {
      const qs = params instanceof URLSearchParams ? params.toString() : String(params || "");
      return get(`/api/music/albums?${qs}`, signal);
    },
    getHistory(limit = 120, signal) {
      return get(`/api/music/history?limit=${limit}`, signal);
    },
    getPlaylist(id, signal) {
      return get(`/api/music/playlists/${encodeURIComponent(id)}`, signal);
    },
    getSmartPlaylist(id, params, signal) {
      const qs = params instanceof URLSearchParams ? params.toString() : String(params || "");
      return get(`/api/music/smart-playlists/${encodeURIComponent(id)}?${qs}`, signal);
    },
    getReport(signal) {
      return get("/api/music/report", signal);
    },
    getTrack(id, params, signal) {
      const qs = params instanceof URLSearchParams ? params.toString() : String(params || "");
      return get(`/api/music/tracks/${encodeURIComponent(id)}?${qs}`, signal);
    },
    getPlaylists(signal) {
      return get("/api/music/playlists", signal);
    },
    getSmartPlaylists(signal) {
      return get("/api/music/smart-playlists", signal);
    },
    suggest(query, signal) {
      return get(`/api/music/suggest?q=${encodeURIComponent(query)}`, signal);
    },
    setFavorite(id, favorite, signal) {
      return send(`/api/music/tracks/${encodeURIComponent(id)}/favorite`, "POST", { favorite: Boolean(favorite) }, signal);
    },
    setRating(id, rating, signal) {
      return send(`/api/music/tracks/${encodeURIComponent(id)}/rating`, "POST", { rating }, signal);
    },
    setProgress(id, body, signal) {
      return send(`/api/music/tracks/${encodeURIComponent(id)}/progress`, "POST", body, signal);
    },
    createPlaylist(body, signal) {
      return send("/api/music/playlists", "POST", body, signal);
    },
    addTrackToPlaylist(id, body, signal) {
      return send(`/api/music/playlists/${encodeURIComponent(id)}/tracks`, "POST", body, signal);
    },
    reorderPlaylist(id, body, signal) {
      return send(`/api/music/playlists/${encodeURIComponent(id)}/tracks/order`, "PUT", body, signal);
    },
    updatePlaylist(id, body, signal) {
      return send(`/api/music/playlists/${encodeURIComponent(id)}`, "PUT", body, signal);
    },
    deletePlaylist(id, signal) {
      return send(`/api/music/playlists/${encodeURIComponent(id)}`, "DELETE", undefined, signal);
    },
    removeTrackFromPlaylist(id, trackId, signal) {
      return send(`/api/music/playlists/${encodeURIComponent(id)}/tracks/${encodeURIComponent(trackId)}`, "DELETE", undefined, signal);
    },
    importM3u(body, signal) {
      return send("/api/music/playlists/import-m3u", "POST", body, signal);
    },
    clearHistory(signal) {
      return send("/api/music/history", "DELETE", undefined, signal);
    },
    runScript(body, signal) {
      return send("/api/admin/scripts/run", "POST", body, signal);
    }
  };
}
