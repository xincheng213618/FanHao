export async function routeMusicApi(req, res, url, deps) {
  const { musicStore, notFound, readJsonBody, requireLocalAdmin, sendJson } = deps;

  if (url.pathname === "/api/music/summary" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.summary());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "音乐概览读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/facets" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.facets());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "音乐筛选信息读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/artists" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.listArtists(url));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "歌手列表读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/albums" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.listAlbums(url));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "专辑列表读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/tracks" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.listTracks(url));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "歌曲列表读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/rescan" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, musicStore.scan(body || {}));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "音乐目录扫描失败" });
    }
    return true;
  }

  const progressMatch = /^\/api\/music\/tracks\/([^/]+)\/progress$/.exec(url.pathname);
  if (progressMatch && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const track = musicStore.saveProgress(decodeURIComponent(progressMatch[1]), body || {});
      if (!track) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, track });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "播放进度保存失败" });
    }
    return true;
  }

  const favoriteMatch = /^\/api\/music\/tracks\/([^/]+)\/favorite$/.exec(url.pathname);
  if (favoriteMatch && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const track = musicStore.toggleFavorite(decodeURIComponent(favoriteMatch[1]), body || {});
      if (!track) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, track });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "收藏歌曲失败" });
    }
    return true;
  }

  const trackMatch = /^\/api\/music\/tracks\/([^/]+)$/.exec(url.pathname);
  if (trackMatch && req.method === "GET") {
    try {
      const data = musicStore.trackDetail(decodeURIComponent(trackMatch[1]), url);
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "歌曲详情读取失败" });
    }
    return true;
  }

  return false;
}
