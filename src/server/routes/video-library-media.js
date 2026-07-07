export async function routeVideoLibraryMedia(req, res, url, deps) {
  const {
    library,
    mediaResponseService,
    mediaStreamService,
    notFound,
    resolveVideoFileByPublicId
  } = deps;

  const actorAvatarMatch = /^\/media\/actor\/([^/]+)\/avatar$/.exec(url.pathname);
  if (actorAvatarMatch && req.method === "GET") {
    mediaResponseService.serveActorAvatar(res, decodeURIComponent(actorAvatarMatch[1]));
    return true;
  }

  const workCoverMatch = /^\/media\/work\/([^/]+)\/cover$/.exec(url.pathname);
  if (workCoverMatch && req.method === "GET") {
    mediaResponseService.serveWorkCover(res, decodeURIComponent(workCoverMatch[1]));
    return true;
  }

  const coreImageMatch = /^\/media\/core-image\/([^/]+)$/.exec(url.pathname);
  if (coreImageMatch && req.method === "GET") {
    mediaResponseService.serveCoreImage(res, decodeURIComponent(coreImageMatch[1]));
    return true;
  }

  const imageMatch = /^\/media\/image\/([^/]+)$/.exec(url.pathname);
  if (imageMatch && req.method === "GET") {
    const file = library.filesById.get(imageMatch[1]);
    if (!file || file.type !== "image") {
      notFound(res);
      return true;
    }

    mediaResponseService.serveImage(res, file);
    return true;
  }

  const transcodeMatch = /^\/media\/video\/([^/]+)\/transcode$/.exec(url.pathname);
  if (transcodeMatch && req.method === "GET") {
    const file = resolveVideoFileByPublicId(transcodeMatch[1]);
    if (!file || file.type !== "video") {
      notFound(res);
      return true;
    }

    mediaStreamService.serveTranscodedVideo(req, res, file, url);
    return true;
  }

  const videoMatch = /^\/media\/video\/([^/]+)$/.exec(url.pathname);
  if (videoMatch && req.method === "GET") {
    const file = resolveVideoFileByPublicId(videoMatch[1]);
    if (!file || file.type !== "video") {
      notFound(res);
      return true;
    }

    mediaStreamService.serveVideo(req, res, file);
    return true;
  }

  return false;
}
