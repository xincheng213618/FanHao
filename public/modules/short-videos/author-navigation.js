const AUTHOR_INDEX_SOURCES = new Set(["authors", "following"]);
export const AUTHOR_INDEX_WINDOW_TTL_MS = 120_000;
export const AUTHOR_INDEX_WINDOW_MAX_AUTHORS = 768;

export function captureAuthorIndexReturnContext(shortVideo = {}) {
  const currentSource = String(shortVideo.source || "").trim();
  const source = AUTHOR_INDEX_SOURCES.has(currentSource)
    ? currentSource
    : (AUTHOR_INDEX_SOURCES.has(shortVideo.authorIndexSource) ? shortVideo.authorIndexSource : "authors");
  const onAuthorIndex = !shortVideo.authorPage && AUTHOR_INDEX_SOURCES.has(currentSource);
  return {
    source,
    query: onAuthorIndex ? String(shortVideo.query || "").trim() : "",
    sort: String(shortVideo.sort || "published").trim() || "published",
    authorSort: String(shortVideo.authorSort || "followed").trim() || "followed",
    authorFilter: String(shortVideo.authorFilter || "all").trim() || "all",
    accountStatus: String(shortVideo.authorAccountStatus || "all").trim() || "all"
  };
}

export function authorIndexReturnState(context = {}) {
  const source = AUTHOR_INDEX_SOURCES.has(context.source) ? context.source : "authors";
  return {
    source,
    query: String(context.query || "").trim(),
    sort: String(context.sort || "published").trim() || "published",
    authorSort: String(context.authorSort || "followed").trim() || "followed",
    authorFilter: source === "following" ? String(context.authorFilter || "all").trim() || "all" : "all",
    authorAccountStatus: source === "authors" ? String(context.accountStatus || "all").trim() || "all" : "all"
  };
}

export function captureAuthorIndexWindow(shortVideo = {}, scrollY = 0, authorId = "", now = Date.now()) {
  const authors = Array.isArray(shortVideo.authors) ? [...shortVideo.authors] : [];
  const stableAuthorId = String(authorId || "").trim();
  if (!stableAuthorId || authors.length > AUTHOR_INDEX_WINDOW_MAX_AUTHORS) return null;
  return {
    context: captureAuthorIndexReturnContext(shortVideo),
    authorId: stableAuthorId,
    authors,
    authorTotal: Math.max(0, Number(shortVideo.authorTotal || 0)),
    authorScopeTotal: Math.max(0, Number(shortVideo.authorScopeTotal || 0)),
    authorUnlikedTotal: Math.max(0, Number(shortVideo.authorUnlikedTotal || 0)),
    authorBannedTotal: Math.max(0, Number(shortVideo.authorBannedTotal || 0)),
    authorHasMore: Boolean(shortVideo.authorHasMore),
    createdAt: Math.max(0, Number(now || 0)),
    scrollY: Math.max(0, Number(scrollY || 0))
  };
}

export function matchesAuthorIndexWindow(snapshot, shortVideo = {}, now = Date.now()) {
  const age = Number(now || 0) - Number(snapshot?.createdAt || 0);
  if (
    !snapshot?.context
    || !String(snapshot.authorId || "").trim()
    || !Array.isArray(snapshot.authors)
    || snapshot.authors.length > AUTHOR_INDEX_WINDOW_MAX_AUTHORS
    || age < 0
    || age > AUTHOR_INDEX_WINDOW_TTL_MS
    || shortVideo.authorPage
  ) return false;
  const expected = authorIndexReturnState(snapshot.context);
  const actual = authorIndexReturnState(captureAuthorIndexReturnContext(shortVideo));
  return Object.keys(expected).every((key) => expected[key] === actual[key]);
}

export function discardAuthorIndexWindowAfterRouteChange(shortVideo = {}, previousAuthorPage = "") {
  const snapshot = shortVideo.authorIndexWindow;
  if (!snapshot) return false;
  const returningFromCapturedAuthor = String(previousAuthorPage || "").trim() === String(snapshot.authorId || "").trim();
  if (returningFromCapturedAuthor && matchesAuthorIndexWindow(snapshot, shortVideo)) return true;
  shortVideo.authorIndexWindow = null;
  return false;
}

export function restoreAuthorIndexWindow(shortVideo = {}, snapshot = {}) {
  shortVideo.authors = Array.isArray(snapshot.authors) ? [...snapshot.authors] : [];
  shortVideo.authorTotal = Math.max(0, Number(snapshot.authorTotal || 0));
  shortVideo.authorScopeTotal = Math.max(0, Number(snapshot.authorScopeTotal || 0));
  shortVideo.authorUnlikedTotal = Math.max(0, Number(snapshot.authorUnlikedTotal || 0));
  shortVideo.authorBannedTotal = Math.max(0, Number(snapshot.authorBannedTotal || 0));
  shortVideo.authorHasMore = Boolean(snapshot.authorHasMore);
  shortVideo.authorLoadingMore = false;
  shortVideo.loading = false;
  shortVideo.status = "";
  return Math.max(0, Number(snapshot.scrollY || 0));
}

export function restoreAuthorIndexScroll(scrollY = 0) {
  const target = Math.max(0, Number(scrollY || 0));
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: target, left: 0, behavior: "auto" });
    });
  });
}

export function restoreAuthorIndexFocus(snapshot = {}) {
  const authorId = String(snapshot.authorId || "").trim();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const card = authorId
        ? document.querySelector(`.short-video-author-index-card-main[data-short-video-author-id="${CSS.escape(authorId)}"]`)
        : null;
      const fallback = document.querySelector("[data-short-video-author-index-heading]");
      (card || fallback)?.focus?.({ preventScroll: true });
    });
  });
}

export function restoreSavedAuthorIndexWindow(shortVideo = {}, append = false, render = () => {}) {
  if (append || !matchesAuthorIndexWindow(shortVideo.authorIndexWindow, shortVideo)) return false;
  const snapshot = shortVideo.authorIndexWindow;
  shortVideo.authorIndexWindow = null;
  const scrollY = restoreAuthorIndexWindow(shortVideo, snapshot);
  render();
  restoreAuthorIndexScroll(scrollY);
  restoreAuthorIndexFocus(snapshot);
  return true;
}

export function canReturnThroughShortVideoHistory({ enteredWithinApp = false, referrer = "", currentHref = "" } = {}) {
  if (enteredWithinApp) return true;
  const previousHref = String(referrer || "").trim();
  if (!previousHref) return false;
  try {
    const current = new URL(currentHref || "http://127.0.0.1/");
    const previous = new URL(previousHref, current);
    return previous.origin === current.origin && /^\/(?:short-videos|short-video|douyin)(?:\/|$)/.test(previous.pathname);
  } catch {
    return false;
  }
}
