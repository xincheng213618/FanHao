import { decodeShortVideoDetailSegment, SHORT_VIDEO_RESERVED_DETAIL_SEGMENTS } from "./reserved-routes.js";
import { sendShortVideoPublicError } from "./public-errors.js";

export async function routeShortVideoApi(req, res, url, deps) {
  const { listVideos, notFound, onMutation, onWatch, onWatchMutation, readJsonBody, recordWatch, refreshLikeDistribution, requestSignal, requireLocalAdmin, sendJson, shortVideoStore } = deps;

  if (url.pathname === "/api/short-videos/summary" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.summary());
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频概览读取失败");
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/facets" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.facets());
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频筛选信息读取失败");
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/like-distribution" && req.method === "GET") {
    try {
      sendJson(res, 200, await shortVideoStore.likeDistribution({ signal: requestSignal }));
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频点赞分布读取失败");
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/like-distribution/refresh" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      sendJson(res, 200, await refreshLikeDistribution({ signal: requestSignal }));
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频点赞分布刷新失败");
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/quality-upgrades" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const result = shortVideoStore.queueQualityUpgrades(Array.isArray(body?.ids) ? body.ids : []);
      onMutation?.();
      sendJson(res, 200, result);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "高清重下排队失败");
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/authors" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.listAuthors(url));
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频作者读取失败");
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
      sendShortVideoPublicError(res, sendJson, error, "作者提及解析失败");
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/suggestions" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.searchSuggestions(url));
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频搜索建议读取失败");
    }
    return true;
  }

  if (url.pathname === "/api/short-videos" && req.method === "GET") {
    try {
      const data = listVideos ? await listVideos(url) : shortVideoStore.listVideos(url);
      sendJson(res, 200, data);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频列表读取失败");
    }
    return true;
  }

  if (url.pathname === "/api/short-videos" && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      const result = await shortVideoStore.deleteVideos(ids, {
        deleteFiles: body?.deleteFiles !== false,
        ...(Object.hasOwn(body || {}, "operationId") ? { operationId: body.operationId } : {})
      });
      onMutation?.();
      sendJson(res, shortVideoDeleteResponseStatus(result), result);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频批量删除失败", { includeDetails: true });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/delete-jobs" && req.method === "GET") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const jobId = String(url.searchParams.get("jobId") || "").trim();
      sendJson(res, 200, shortVideoStore.deleteJobStatus({ jobId }));
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频删除恢复状态读取失败");
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/delete-jobs" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const result = await shortVideoStore.recoverDeleteJobs({ jobId: String(body?.jobId || "").trim() });
      onMutation?.();
      sendJson(res, shortVideoRecoveryResponseStatus(result), result);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频删除恢复失败");
    }
    return true;
  }

  const explicitVideoDetailMatch = /^\/api\/short-videos\/videos\/([^/]+)$/.exec(url.pathname);
  if (explicitVideoDetailMatch && req.method === "GET") {
    const data = shortVideoStore.videoDetail(decodeShortVideoRouteId(explicitVideoDetailMatch[1]), url);
    if (!data) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, data);
    return true;
  }

  if (explicitVideoDetailMatch && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const options = {
        deleteFiles: body?.deleteFiles !== false,
        ...(Object.hasOwn(body || {}, "operationId") ? { operationId: body.operationId } : {})
      };
      const scope = String(body?.scope || url.searchParams.get("scope") || "").trim().toLowerCase();
      const videoId = decodeShortVideoRouteId(explicitVideoDetailMatch[1]);
      const result = scope === "group" || scope === "folder"
        ? await shortVideoStore.deleteVideoGroup(videoId, options)
        : await shortVideoStore.deleteVideo(videoId, options);
      onMutation?.();
      sendJson(res, shortVideoDeleteResponseStatus(result), result);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频删除失败", { includeDetails: true });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/collections" && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.listCollections());
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频清单读取失败", { includeRetryable: true });
    }
    return true;
  }

  if (url.pathname === "/api/short-videos/collections" && req.method === "POST") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const result = shortVideoStore.createCollection(body || {});
      onMutation?.();
      sendJson(res, 201, result);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频清单创建失败", { includeRetryable: true });
    }
    return true;
  }

  const collectionMatch = /^\/api\/short-videos\/collections\/([^/]+)$/.exec(url.pathname);
  if (collectionMatch && req.method === "PATCH") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const result = shortVideoStore.renameCollection(decodeShortVideoRouteId(collectionMatch[1]), body || {});
      onMutation?.();
      sendJson(res, 200, result);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频清单重命名失败", { includeRetryable: true });
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
      sendShortVideoPublicError(res, sendJson, error, "短视频清单删除失败", { includeRetryable: true });
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
      sendShortVideoPublicError(res, sendJson, error, "短视频清单内容读取失败", { includeRetryable: true });
    }
    return true;
  }

  const collectionVideoMatch = /^\/api\/short-videos\/collections\/([^/]+)\/videos\/([^/]+)$/.exec(url.pathname);
  if (collectionVideoMatch && req.method === "GET") {
    try {
      sendJson(res, 200, shortVideoStore.collectionVideoDetail(
        decodeShortVideoRouteId(collectionVideoMatch[1]),
        decodeShortVideoRouteId(collectionVideoMatch[2])
      ));
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频清单详情读取失败", { includeRetryable: true });
    }
    return true;
  }

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
      sendShortVideoPublicError(res, sendJson, error, "短视频清单内容保存失败", { includeRetryable: true });
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
      sendShortVideoPublicError(res, sendJson, error, "短视频点赞目录扫描失败");
    }
    return true;
  }

  const actionMatch = /^\/api\/short-videos\/([^/]+)\/actions\/(like|collect|dislike)$/.exec(url.pathname);
  if (actionMatch && (req.method === "PUT" || req.method === "POST")) {
    try {
      const body = await readJsonBody(req);
      const data = shortVideoStore.setUserAction(
        decodeURIComponent(actionMatch[1]),
        actionMatch[2],
        body || {}
      );
      onMutation?.();
      sendJson(res, 200, data);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频互动状态保存失败");
    }
    return true;
  }

  const followMatch = /^\/api\/short-videos\/([^/]+)\/author-follow$/.exec(url.pathname);
  if (followMatch && (req.method === "PUT" || req.method === "POST")) {
    try {
      const body = await readJsonBody(req);
      const data = shortVideoStore.setAuthorFollow(decodeURIComponent(followMatch[1]), body || {});
      onMutation?.();
      sendJson(res, 200, data);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "作者关注状态保存失败");
    }
    return true;
  }

  const authorFollowMatch = /^\/api\/short-videos\/authors\/([^/]+)\/follow$/.exec(url.pathname);
  if (authorFollowMatch && (req.method === "PUT" || req.method === "POST")) {
    try {
      const body = await readJsonBody(req);
      const data = shortVideoStore.setAuthorFollowByUser(decodeURIComponent(authorFollowMatch[1]), body || {});
      onMutation?.();
      sendJson(res, 200, data);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "关注账号移除失败");
    }
    return true;
  }

  const watchMatch = /^\/api\/short-videos\/([^/]+)\/watch$/.exec(url.pathname);
  if (watchMatch && (req.method === "PUT" || req.method === "POST")) {
    try {
      const videoId = decodeURIComponent(watchMatch[1]);
      const body = await readJsonBody(req);
      const data = recordWatch
        ? await recordWatch(videoId, body || {})
        : shortVideoStore.recordWatch(videoId, body || {});
      onWatchMutation?.(videoId, body || {}, data);
      onWatch?.(videoId, body || {}, data);
      sendJson(res, 200, data);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "观看进度保存失败", { includeRetryable: true });
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
      sendShortVideoPublicError(res, sendJson, error, "本地评论读取失败");
    }
    return true;
  }

  if (commentsMatch && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      sendJson(res, 201, shortVideoStore.createLocalComment(decodeURIComponent(commentsMatch[1]), body || {}));
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "本地评论保存失败");
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
      sendShortVideoPublicError(res, sendJson, error, "本地评论删除失败");
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
  const detailSegment = detailMatch ? decodeShortVideoDetailSegment(detailMatch[1]) : null;
  if (detailMatch && !detailSegment?.ok) {
    sendJson(res, 400, { error: "请求 ID 无效" });
    return true;
  }
  if (
    detailMatch
    && SHORT_VIDEO_RESERVED_DETAIL_SEGMENTS.has(detailSegment.value.toLowerCase())
  ) {
    notFound(res);
    return true;
  }
  if (detailMatch && req.method === "DELETE") {
    if (!requireLocalAdmin(req, res)) return true;
    try {
      const body = await readJsonBody(req);
      const options = {
        deleteFiles: body?.deleteFiles !== false,
        ...(Object.hasOwn(body || {}, "operationId") ? { operationId: body.operationId } : {})
      };
      const scope = String(body?.scope || url.searchParams.get("scope") || "").trim().toLowerCase();
      const result = scope === "group" || scope === "folder"
        ? await shortVideoStore.deleteVideoGroup(detailSegment.value, options)
        : await shortVideoStore.deleteVideo(detailSegment.value, options);
      onMutation?.();
      sendJson(res, shortVideoDeleteResponseStatus(result), result);
    } catch (error) {
      sendShortVideoPublicError(res, sendJson, error, "短视频删除失败", { includeDetails: true });
    }
    return true;
  }

  if (detailMatch && req.method === "GET") {
    const data = shortVideoStore.videoDetail(detailSegment.value, url);
    if (!data) {
      notFound(res);
      return true;
    }
    sendJson(res, 200, data);
    return true;
  }

  return false;
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

function shortVideoDeleteResponseStatus(result) {
  if (result?.keyedOperation === true && [200, 202, 409, 500].includes(Number(result?.httpStatus))) {
    return Number(result.httpStatus);
  }
  if (result?.status === "rollback_pending" || result?.recoveryRequired === true) return 500;
  return result?.status === "cleanup_pending" || result?.pending === true ? 202 : 200;
}

function shortVideoRecoveryResponseStatus(result) {
  if (result?.job?.keyedOperation === true && result.job.manualInterventionRequired === true) return 409;
  if (Array.isArray(result?.jobs)
    && result.jobs.some((job) => job?.keyedOperation === true && job?.manualInterventionRequired === true)) return 409;
  if (result?.pending === true) return 202;
  if (result?.job?.pending === true) return 202;
  if (Array.isArray(result?.jobs) && result.jobs.some((job) => job?.pending === true)) return 202;
  return 200;
}
