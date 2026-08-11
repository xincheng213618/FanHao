export function appendCollectionCursorBoundary(boundaries = [], page = {}, mergedVideos = [], previousVideos = []) {
  const existing = normalizedBoundaries(boundaries);
  const incoming = Array.isArray(page?.videos) ? page.videos : [];
  const endVideoId = String(incoming.at(-1)?.id || "").trim();
  if (!endVideoId || !mergedVideos.some((video) => String(video?.id || "") === endVideoId)) return existing;

  const previousIds = new Set((previousVideos || []).map((video) => String(video?.id || "")).filter(Boolean));
  if (incoming.some((video) => previousIds.has(String(video?.id || "")))) {
    // A defensive de-duplication changed the page's positional shape. Keep
    // older trusted boundaries and make the native bridge use its safe
    // offset fallback instead of associating this cursor with the wrong row.
    return existing;
  }

  return [
    ...existing.filter((boundary) => boundary.endVideoId !== endVideoId),
    {
      endVideoId,
      hasMore: Boolean(page?.hasMore),
      nextCursor: String(page?.nextCursor || "")
    }
  ];
}

export function removeCollectionCursorBoundaryVideo(boundaries = [], videoId = "") {
  const removedId = String(videoId || "").trim();
  return normalizedBoundaries(boundaries).filter((boundary) => boundary.endVideoId !== removedId);
}

function normalizedBoundaries(boundaries = []) {
  const normalized = [];
  const seen = new Set();
  for (const boundary of Array.isArray(boundaries) ? boundaries : []) {
    const endVideoId = String(boundary?.endVideoId || "").trim();
    if (!endVideoId || seen.has(endVideoId)) continue;
    seen.add(endVideoId);
    normalized.push({
      endVideoId,
      hasMore: Boolean(boundary?.hasMore),
      nextCursor: String(boundary?.nextCursor || "")
    });
  }
  return normalized;
}
