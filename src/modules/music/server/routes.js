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

  if (url.pathname === "/api/music/report" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.report());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "听歌报告读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/suggest" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.suggest(url));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "搜索联想读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/lyrics/search" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.searchLyrics(url));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "歌词搜索失败" });
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

  if (url.pathname === "/api/music/history" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.listHistory(url));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "最近播放读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/history" && req.method === "DELETE") {
    try {
      sendJson(res, 200, musicStore.clearHistory());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "清空最近播放失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/playlists" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.listPlaylists());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "歌单列表读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/smart-playlists" && req.method === "GET") {
    try {
      sendJson(res, 200, musicStore.listSmartPlaylists());
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "智能歌单列表读取失败" });
    }
    return true;
  }

  const smartPlaylistMatch = /^\/api\/music\/smart-playlists\/([^/]+)$/.exec(url.pathname);
  if (smartPlaylistMatch && req.method === "GET") {
    try {
      const data = musicStore.smartPlaylistDetail(decodeURIComponent(smartPlaylistMatch[1]), url);
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "智能歌单详情读取失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/playlists" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, musicStore.createPlaylist(body || {}));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "创建歌单失败" });
    }
    return true;
  }

  if (url.pathname === "/api/music/playlists/import-m3u" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, musicStore.importM3uPlaylist(body || {}));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "导入 M3U 歌单失败" });
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

  const ratingMatch = /^\/api\/music\/tracks\/([^/]+)\/rating$/.exec(url.pathname);
  if (ratingMatch && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const track = musicStore.setRating(decodeURIComponent(ratingMatch[1]), body || {});
      if (!track) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, { ok: true, track });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "评分保存失败" });
    }
    return true;
  }

  const playlistTrackMatch = /^\/api\/music\/playlists\/([^/]+)\/tracks$/.exec(url.pathname);
  if (playlistTrackMatch && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const trackId = String(body?.trackId || body?.track_id || "").trim();
      if (!trackId) {
        sendJson(res, 400, { error: "缺少歌曲 ID" });
        return true;
      }
      const data = musicStore.addToPlaylist(decodeURIComponent(playlistTrackMatch[1]), trackId);
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "加入歌单失败" });
    }
    return true;
  }

  const playlistTrackOrderMatch = /^\/api\/music\/playlists\/([^/]+)\/tracks\/order$/.exec(url.pathname);
  if (playlistTrackOrderMatch && (req.method === "PUT" || req.method === "PATCH")) {
    try {
      const body = await readJsonBody(req);
      const data = musicStore.reorderPlaylist(decodeURIComponent(playlistTrackOrderMatch[1]), body || {});
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "歌单排序保存失败" });
    }
    return true;
  }

  const playlistTrackDeleteMatch = /^\/api\/music\/playlists\/([^/]+)\/tracks\/([^/]+)$/.exec(url.pathname);
  if (playlistTrackDeleteMatch && req.method === "DELETE") {
    try {
      const data = musicStore.removeFromPlaylist(decodeURIComponent(playlistTrackDeleteMatch[1]), decodeURIComponent(playlistTrackDeleteMatch[2]));
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "移出歌单失败" });
    }
    return true;
  }

  const playlistExportMatch = /^\/api\/music\/playlists\/([^/]+)\/export\.m3u8?$/.exec(url.pathname);
  if (playlistExportMatch && (req.method === "GET" || req.method === "HEAD")) {
    try {
      const data = musicStore.playlistM3u(decodeURIComponent(playlistExportMatch[1]), {
        pathMode: url.searchParams.get("path")
      });
      if (!data) {
        notFound(res);
        return true;
      }
      const body = data.content || "";
      res.writeHead(200, {
        "Content-Type": "audio/x-mpegurl; charset=utf-8",
        "Content-Length": Buffer.byteLength(body, "utf8"),
        "Content-Disposition": attachmentDisposition(data.fileName),
        "Cache-Control": "no-store"
      });
      if (req.method === "HEAD") res.end();
      else res.end(body, "utf8");
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "歌单导出失败" });
    }
    return true;
  }

  const playlistMatch = /^\/api\/music\/playlists\/([^/]+)$/.exec(url.pathname);
  if (playlistMatch && req.method === "GET") {
    try {
      const data = musicStore.playlistDetail(decodeURIComponent(playlistMatch[1]));
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "歌单读取失败" });
    }
    return true;
  }

  if (playlistMatch && req.method === "DELETE") {
    try {
      const data = musicStore.deletePlaylist(decodeURIComponent(playlistMatch[1]));
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "删除歌单失败" });
    }
    return true;
  }

  if (playlistMatch && (req.method === "PUT" || req.method === "PATCH")) {
    try {
      const body = await readJsonBody(req);
      const data = musicStore.updatePlaylist(decodeURIComponent(playlistMatch[1]), body || {});
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "更新歌单失败" });
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

function attachmentDisposition(fileName) {
  const name = String(fileName || "playlist.m3u8").replace(/[\\/\u0000-\u001f]/g, "_");
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "playlist.m3u8";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
