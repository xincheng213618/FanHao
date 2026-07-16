export async function routeUserStateApi(req, res, url, deps) {
  const {
    clampInteger,
    favoriteStateService,
    library,
    maxWorkLimit,
    notFound,
    playbackProgressService,
    publicWork,
    readJsonBody,
    recentWatchedDays,
    resolvePlayableVideoFile,
    sendJson
  } = deps;

  if (url.pathname === "/api/favorites" && req.method === "GET") {
    const rawFolderId = url.searchParams.get("folder") || "";
    const selectedFolderId = rawFolderId ? favoriteStateService.normalizeFavoriteFolderId(rawFolderId) : "";
    const allWorks = favoriteStateService.favoriteWorks(selectedFolderId);
    const limit = clampInteger(url.searchParams.get("limit"), 0, 0, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const page = limit ? allWorks.slice(offset, offset + limit) : allWorks.slice(offset);
    const works = page.map((work) => publicWork(work));
    sendJson(res, 200, {
      count: works.length,
      total: allWorks.length,
      limit,
      offset,
      works,
      folders: favoriteStateService.publicFavoriteFolders(),
      selectedFolderId: selectedFolderId || "all"
    });
    return true;
  }

  if (url.pathname === "/api/favorite-folders" && req.method === "GET") {
    sendJson(res, 200, { folders: favoriteStateService.publicFavoriteFolders() });
    return true;
  }

  if (url.pathname === "/api/favorite-folders" && req.method === "POST") {
    const body = await readJsonBody(req);
    try {
      const folder = favoriteStateService.createFavoriteFolder(body.name);
      sendJson(res, 200, {
        ok: true,
        folder: { ...folder, count: favoriteStateService.favoriteFolderCounts().get(folder.id) || 0 },
        folders: favoriteStateService.publicFavoriteFolders(),
        user: playbackProgressService.userStateSummary()
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message || "创建收藏夹失败" });
    }
    return true;
  }

  if (url.pathname === "/api/history" && req.method === "GET") {
    const rawDays = String(url.searchParams.get("days") || "").trim().toLowerCase();
    const days = rawDays && rawDays !== "all" ? clampInteger(rawDays, 0, 1, 3650) : 0;
    const limit = clampInteger(url.searchParams.get("limit"), 0, 0, maxWorkLimit);
    const offset = clampInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const entries = playbackProgressService.historyEntries({ days });
    const page = limit ? entries.slice(offset, offset + limit) : entries.slice(offset);
    const works = page.map((entry) => publicWork(entry.work));
    sendJson(res, 200, {
      count: works.length,
      total: entries.length,
      days,
      limit,
      offset,
      recentWatchedDays,
      works
    });
    return true;
  }

  const favoriteFolderMatch = /^\/api\/favorites\/([^/]+)\/folder$/.exec(url.pathname);
  if (favoriteFolderMatch && req.method === "PUT") {
    const workId = decodeURIComponent(favoriteFolderMatch[1]);
    if (!library.worksById.has(workId)) {
      notFound(res);
      return true;
    }

    const body = await readJsonBody(req);
    try {
      const favorite = favoriteStateService.moveFavoriteToFolder(workId, body.folderId);
      sendJson(res, 200, {
        ok: true,
        workId,
        favorite,
        folders: favoriteStateService.publicFavoriteFolders(),
        user: playbackProgressService.userStateSummary()
      });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message || "移动收藏夹失败" });
    }
    return true;
  }

  const favoriteMatch = /^\/api\/favorites\/([^/]+)$/.exec(url.pathname);
  if (favoriteMatch && req.method === "POST") {
    const workId = decodeURIComponent(favoriteMatch[1]);
    if (!library.worksById.has(workId)) {
      notFound(res);
      return true;
    }

    const body = await readJsonBody(req);
    sendJson(res, 200, { ...favoriteStateService.toggleFavorite(workId, body), user: playbackProgressService.userStateSummary() });
    return true;
  }

  const progressMatch = /^\/api\/progress\/([^/]+)$/.exec(url.pathname);
  if (progressMatch && req.method === "POST") {
    const videoId = decodeURIComponent(progressMatch[1]);
    const file = resolvePlayableVideoFile(videoId);
    if (!file || file.type !== "video") {
      notFound(res);
      return true;
    }

    const body = await readJsonBody(req);
    try {
      sendJson(res, 200, { ok: true, progress: playbackProgressService.saveVideoProgress(videoId, body), user: playbackProgressService.userStateSummary() });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message || "播放进度无效" });
    }
    return true;
  }

  return false;
}
