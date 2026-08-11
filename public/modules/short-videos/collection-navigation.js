const COLLECTION_WINDOW_TTL_MS = 5 * 60 * 1000;

export function captureCollectionWindow(shortVideo = {}, scrollY = 0, anchorVideoId = "", activeElement = null, now = Date.now()) {
  const data = shortVideo.collectionData;
  const collectionId = String(data?.collection?.id || shortVideo.collectionId || "").trim();
  if (!collectionId || !Array.isArray(data?.videos)) return null;
  const focusedCard = activeElement?.closest?.("[data-collection-video-id]");
  return {
    collectionId,
    createdAt: Math.max(0, Number(now || 0)),
    scrollY: Math.max(0, Number(scrollY || 0)),
    anchorVideoId: String(anchorVideoId || ""),
    focusVideoId: String(focusedCard?.dataset?.collectionVideoId || anchorVideoId || ""),
    data: {
      ...data,
      collection: data.collection ? { ...data.collection } : null,
      videos: [...data.videos]
    }
  };
}

export function restoreCollectionWindow(shortVideo = {}, snapshot = {}, render = () => {}) {
  if (!matchesCollectionWindow(snapshot, shortVideo.collectionId)) return false;
  shortVideo.collectionData = {
    ...snapshot.data,
    collection: snapshot.data.collection ? { ...snapshot.data.collection } : null,
    videos: [...snapshot.data.videos]
  };
  shortVideo.data = {
    videos: shortVideo.collectionData.videos,
    total: Number(shortVideo.collectionData.total || shortVideo.collectionData.videos.length),
    hasMore: Boolean(shortVideo.collectionData.hasMore),
    nextCursor: shortVideo.collectionData.nextCursor || null
  };
  shortVideo.collectionLoading = false;
  shortVideo.collectionError = "";
  render();
  restoreCollectionPosition(snapshot);
  return true;
}

export function matchesCollectionWindow(snapshot, collectionId, now = Date.now()) {
  const age = Number(now || 0) - Number(snapshot?.createdAt || 0);
  return Boolean(
    snapshot?.data
    && Array.isArray(snapshot.data.videos)
    && String(snapshot.collectionId || "") === String(collectionId || "")
    && age >= 0
    && age <= COLLECTION_WINDOW_TTL_MS
  );
}

export function restoreCollectionPosition(snapshot = {}) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: Math.max(0, Number(snapshot.scrollY || 0)), left: 0, behavior: "auto" });
      const videoId = String(snapshot.focusVideoId || snapshot.anchorVideoId || "").trim();
      const target = videoId
        ? document.querySelector(`[data-collection-video-id="${CSS.escape(videoId)}"] .short-video-thumb-open`)
          || document.querySelector(`[data-collection-video-id="${CSS.escape(videoId)}"]`)
        : null;
      target?.focus?.({ preventScroll: true });
    });
  });
}

export function captureCollectionFeedWindow(shortVideo = {}, scrollY = 0, activeElement = null, now = Date.now()) {
  const focusedCollection = activeElement?.closest?.("[data-collection-id]");
  return {
    createdAt: Math.max(0, Number(now || 0)),
    routeSignature: collectionFeedRouteSignature(shortVideo),
    scrollY: Math.max(0, Number(scrollY || 0)),
    focusCollectionId: String(focusedCollection?.dataset?.collectionId || ""),
    state: {
      ...shortVideo,
      data: clonePageData(shortVideo.data),
      authors: Array.isArray(shortVideo.authors) ? [...shortVideo.authors] : shortVideo.authors,
      collections: Array.isArray(shortVideo.collections) ? [...shortVideo.collections] : []
    }
  };
}

export function restoreCollectionFeedWindow(shortVideo = {}, snapshot = {}, render = () => {}, targetRoute = null) {
  const age = Date.now() - Number(snapshot?.createdAt || 0);
  if (!snapshot?.state || age < 0 || age > COLLECTION_WINDOW_TTL_MS) return false;
  if (targetRoute && snapshot.routeSignature !== collectionFeedRouteSignature(targetRoute)) return false;
  Object.assign(shortVideo, snapshot.state, { data: clonePageData(snapshot.state.data) });
  render();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: Math.max(0, Number(snapshot.scrollY || 0)), left: 0, behavior: "auto" });
      const collectionId = String(snapshot.focusCollectionId || "").trim();
      const focusTarget = collectionId
        ? document.querySelector(`.short-video-collection-sidebar-item[data-collection-id="${CSS.escape(collectionId)}"]`)
        : null;
      focusTarget?.focus?.({ preventScroll: true });
    });
  });
  return true;
}

export function collectionFeedRouteSignature(value = {}) {
  const routeShape = Object.hasOwn(value, "shortVideoMode") || Object.hasOwn(value, "shortVideoSource");
  const field = (stateName, routeName, fallback = "") => String(
    routeShape ? value?.[routeName] ?? fallback : value?.[stateName] ?? fallback
  );
  return JSON.stringify([
    field("mode", "shortVideoMode", "feed"),
    field("authorPage", "shortVideoAuthorPage"),
    field("query", "shortVideoQuery"),
    field("topic", "shortVideoTopic"),
    field("sound", "shortVideoSound"),
    field("author", "shortVideoAuthor", "all"),
    field("media", "shortVideoMedia", "all"),
    field("quality", "shortVideoQuality", "all"),
    field("deleted", "shortVideoDeleted", "all"),
    field("authorAccountStatus", "shortVideoAuthorAccountStatus", "all"),
    field("source", "shortVideoSource", "liked"),
    field("sort", "shortVideoSort", "published")
  ]);
}

function clonePageData(data) {
  if (!data || typeof data !== "object") return data || null;
  return {
    ...data,
    videos: Array.isArray(data.videos) ? [...data.videos] : data.videos,
    authors: Array.isArray(data.authors) ? [...data.authors] : data.authors
  };
}
