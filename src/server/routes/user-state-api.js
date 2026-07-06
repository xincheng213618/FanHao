export async function routeUserStateApi(req, res, url, deps) {
  const {
    clampInteger,
    createFavoriteFolder,
    favoriteFolderCounts,
    favoriteWorks,
    getVideoProgress,
    historyEntries,
    library,
    maxWorkLimit,
    notFound,
    publicFavoriteFolders,
    publicFavoriteForWork,
    publicWork,
    readJsonBody,
    recentWatchedDays,
    resolvePlayableVideoFile,
    sendJson,
    userState,
    userStateService,
    userStateSummary,
    moveFavoriteToFolder
  } = deps;

  if (url.pathname === "/api/favorites" && req.method === "GET") {
    const rawFolderId = url.searchParams.get("folder") || "";
    const selectedFolderId = rawFolderId ? userStateService.normalizeFavoriteFolderId(rawFolderId) : "";
    const works = favoriteWorks(selectedFolderId).map((work) => publicWork(work));
    sendJson(res, 200, {
      count: works.length,
      works,
      folders: publicFavoriteFolders(),
      selectedFolderId: selectedFolderId || "all"
    });
    return true;
  }

  if (url.pathname === "/api/favorite-folders" && req.method === "GET") {
    sendJson(res, 200, { folders: publicFavoriteFolders() });
    return true;
  }

  if (url.pathname === "/api/favorite-folders" && req.method === "POST") {
    const body = await readJsonBody(req);
    try {
      const folder = createFavoriteFolder(body.name);
      userStateService.save();
      sendJson(res, 200, { ok: true, folder: { ...folder, count: favoriteFolderCounts().get(folder.id) || 0 }, folders: publicFavoriteFolders(), user: userStateSummary() });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.message || "创建收藏夹失败" });
    }
    return true;
  }

  if (url.pathname === "/api/history" && req.method === "GET") {
    const rawDays = String(url.searchParams.get("days") || "").trim().toLowerCase();
    const days = rawDays && rawDays !== "all" ? clampInteger(rawDays, 0, 1, 3650) : 0;
    const limit = clampInteger(url.searchParams.get("limit"), 0, 0, maxWorkLimit);
    const entries = historyEntries({ days });
    const page = limit ? entries.slice(0, limit) : entries;
    const works = page.map((entry) => publicWork(entry.work));
    sendJson(res, 200, {
      count: works.length,
      total: entries.length,
      days,
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
      const favorite = moveFavoriteToFolder(workId, body.folderId);
      userStateService.save();
      sendJson(res, 200, {
        ok: true,
        workId,
        favorite,
        folders: publicFavoriteFolders(),
        user: userStateSummary()
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

    if (userState.favorites[workId]) {
      delete userState.favorites[workId];
    } else {
      const body = await readJsonBody(req);
      userState.favorites[workId] = {
        createdAt: new Date().toISOString(),
        folderId: userStateService.normalizeFavoriteFolderId(body.folderId)
      };
    }

    userStateService.save();
    sendJson(res, 200, {
      workId,
      favorite: Boolean(userState.favorites[workId]),
      favoriteFolder: publicFavoriteForWork(workId),
      folders: publicFavoriteFolders(),
      user: userStateSummary()
    });
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
    const position = Number(body.position || 0);
    const duration = Number(body.duration || body.total || 0);
    const bodyWorkId = String(body.workId || "");
    const workId = bodyWorkId && library.worksById.has(bodyWorkId) ? bodyWorkId : null;

    if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) {
      sendJson(res, 400, { error: "播放进度无效" });
      return true;
    }

    userState.progress[videoId] = {
      workId,
      position: Math.max(0, position),
      duration,
      updatedAt: new Date().toISOString()
    };
    userStateService.save();
    sendJson(res, 200, { ok: true, progress: getVideoProgress(videoId, library.worksById.get(workId)), user: userStateSummary() });
    return true;
  }

  return false;
}
