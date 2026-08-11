export async function routeShortVideoApi(req, res, url, deps) {
  const { notFound, onMutation, onWatch, onWatchMutation, readJsonBody, recordWatch, requireLocalAdmin, sendJson, shortVideoStore } = deps;

  if (url.pathname === "/api/short-videos/summary" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.summary());
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频概览读取失败") });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/facets" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.facets());
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频筛选信息读取失败") });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/like-distribution" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.likeDistribution());
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频点赞分布读取失败") });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/quality-upgrades" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const result = shortVideoStore.queueQualityUpgrades(Array.isArray(body?.ids) ? body.ids : []);
      onMutation?.();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "高清重下排队失败" });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/authors" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.listAuthors(url));
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频作者读取失败") });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/authors/resolve" && req.method === "GET") {
    try {
      const mention = String(url.searchParams.get("mention") || "").trim();
      const author = shortVideoStore.resolveAuthorMention(mention);
      if (!author) {
        sendJson(res, 404, { error: mention ? `本地没有找到 @${mention.replace(/^@+\s*/u, "")}` : "缺少作者名称" });
        return true;
      }
      sendJson(res, 200, { author });
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "作者提及解析失败") });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/suggestions" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.searchSuggestions(url));
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频搜索建议读取失败") });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.listVideos(url));
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频列表读取失败") });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos" && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      const result = shortVideoStore.deleteVideos(ids, {
        deleteFiles: body?.deleteFiles !== false
      });
      onMutation?.();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message || "短视频批量删除失败",
        ...(error.details ? { details: error.details } : {})
      });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/collections" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.listCollections());
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频清单读取失败") });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/collections" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const result = shortVideoStore.createCollection(body || {});
      onMutation?.();
      sendJson(res, 201, result);
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频清单创建失败") });
    }
    return true;
  }

  const collectionMatch = /^\/api\/short-videos\/collections\/([^/]+)$/.exec(url.pathname);
  if (collectionMatch && req.method === "PATCH") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const result = shortVideoStore.renameCollection(decodeShortVideoRouteId(collectionMatch[1]), body || {});
      onMutation?.();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频清单重命名失败") });
    }
    return true;
  }

  if (collectionMatch && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const result = shortVideoStore.deleteCollection(decodeShortVideoRouteId(collectionMatch[1]));
      onMutation?.();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频清单删除失败") });
    }
    return true;
  }

  const collectionVideosMatch = /^\/api\/short-videos\/collections\/([^/]+)\/videos$/.exec(url.pathname);
  if (collectionVideosMatch && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.listCollectionVideos(
        decodeShortVideoRouteId(collectionVideosMatch[1]),
        url
      ));
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频清单内容读取失败") });
    }
    return true;
  }

  const collectionVideoMatch = /^\/api\/short-videos\/collections\/([^/]+)\/videos\/([^/]+)$/.exec(url.pathname);
  if (collectionVideoMatch && (req.method === "PUT" || req.method === "DELETE")) {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const collectionId = decodeShortVideoRouteId(collectionVideoMatch[1]);
      const videoId = decodeShortVideoRouteId(collectionVideoMatch[2]);
      const result = req.method === "PUT"
        ? shortVideoStore.addCollectionVideo(collectionId, videoId)
        : shortVideoStore.removeCollectionVideo(collectionId, videoId);
      onMutation?.();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, shortVideoErrorStatus(error), { error: shortVideoErrorMessage(error, "短视频清单内容保存失败") });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/rescan" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const data = shortVideoStore.scan(body?.root || "");
      onMutation?.();
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "短视频点赞目录扫描失败" });
    }
    return true;
  }

  const actionMatch = /^\/api\/short-videos\/([^/]+)\/actions\/(like|collect|dislike)$/.exec(url.pathname);
  if (actionMatch && (req.method === "PUT" || req.method === "POST")) {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const data = shortVideoStore.setUserAction(
        decodeURIComponent(actionMatch[1]),
        actionMatch[2],
        body || {}
      );
      onMutation?.();
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "短视频互动状态保存失败" });
    }
    return true;
  }

  const followMatch = /^\/api\/short-videos\/([^/]+)\/author-follow$/.exec(url.pathname);
  if (followMatch && (req.method === "PUT" || req.method === "POST")) {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const data = shortVideoStore.setAuthorFollow(decodeURIComponent(followMatch[1]), body || {});
      onMutation?.();
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "作者关注状态保存失败" });
    }
    return true;
  }

  const authorFollowMatch = /^\/api\/short-videos\/authors\/([^/]+)\/follow$/.exec(url.pathname);
  if (authorFollowMatch && (req.method === "PUT" || req.method === "POST")) {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const data = shortVideoStore.setAuthorFollowByUser(decodeURIComponent(authorFollowMatch[1]), body || {});
      onMutation?.();
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "关注账号移除失败" });
    }
    return true;
  }

  const watchMatch = /^\/api\/short-videos\/([^/]+)\/watch$/.exec(url.pathname);
  if (watchMatch && (req.method === "PUT" || req.method === "POST")) {
    try {
      const videoId = decodeURIComponent(watchMatch[1]);
      const body = await readJsonBody(req).catch(() => ({}));
      const data = recordWatch
        ? await recordWatch(videoId, body || {})
        : shortVideoStore.recordWatch(videoId, body || {});
      onWatchMutation?.(videoId, body || {}, data);
      onWatch?.(videoId, body || {}, data);
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "观看进度保存失败" });
    }
    return true;
  }

  const commentsMatch = /^\/api\/short-videos\/([^/]+)\/comments$/.exec(url.pathname);
  if (commentsMatch && req.method === "GET") {
    try {
      const data = shortVideoStore.localComments(decodeURIComponent(commentsMatch[1]));
      if (!data) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "本地评论读取失败" });
    }
    return true;
  }

  if (commentsMatch && req.method === "POST") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      sendJson(res, 201, shortVideoStore.createLocalComment(decodeURIComponent(commentsMatch[1]), body || {}));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "本地评论保存失败" });
    }
    return true;
  }

  const commentMatch = /^\/api\/short-videos\/([^/]+)\/comments\/([^/]+)$/.exec(url.pathname);
  if (commentMatch && req.method === "DELETE") {
    try {
      sendJson(res, 200, shortVideoStore.deleteLocalComment(
        decodeURIComponent(commentMatch[1]),
        decodeURIComponent(commentMatch[2])
      ));
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "本地评论删除失败" });
    }
    return true;
  }

  const relatedMatch = /^\/api\/short-videos\/([^/]+)\/related$/.exec(url.pathname);
  if (relatedMatch && req.method === "GET") {
    const data = shortVideoStore.relatedVideos(decodeURIComponent(relatedMatch[1]), url);
    if (!data) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, data);
    return true;
  }

  const adjacentMatch = /^\/api\/short-videos\/([^/]+)\/adjacent$/.exec(url.pathname);
  if (adjacentMatch && req.method === "GET") {
    const direction = url.searchParams.get("direction") === "prev" ? -1 : 1;
    const video = shortVideoStore.adjacentVideo(decodeURIComponent(adjacentMatch[1]), direction, url);
    if (!video) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, { video });
    return true;
  }

  const detailMatch = /^\/api\/short-videos\/([^/]+)$/.exec(url.pathname);
  if (detailMatch && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const options = {
        deleteFiles: body?.deleteFiles !== false
      };
      const scope = String(body?.scope || url.searchParams.get("scope") || "").trim().toLowerCase();
      const result = scope === "group" || scope === "folder"
        ? shortVideoStore.deleteVideoGroup(decodeURIComponent(detailMatch[1]), options)
        : shortVideoStore.deleteVideo(decodeURIComponent(detailMatch[1]), options);
      onMutation?.();
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message || "短视频删除失败",
        ...(error.details ? { details: error.details } : {})
      });
    }
    return true;
  }

  if (detailMatch && req.method === "GET") {
    const data = shortVideoStore.videoDetail(decodeURIComponent(detailMatch[1]), url);
    if (!data) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, data);
    return true;
  }

  return false;
}

function shortVideoErrorStatus(error) {
  if (isShortVideoDatabaseError(error)) return 503;
  return error.statusCode || 500;
}

function shortVideoErrorMessage(error, fallback) {
  if (isShortVideoDatabaseError(error)) return "短视频数据库正在恢复，请稍后重试";
  return error.message || fallback;
}

function isShortVideoDatabaseError(error) {
  const message = String(error?.message || error || "");
  return /database disk image|malformed|sqlite/i.test(message);
}

function decodeShortVideoRouteId(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    const error = new Error("请求 ID 无效");
    error.statusCode = 400;
    throw error;
  }
}
