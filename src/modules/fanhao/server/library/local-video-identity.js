export function sameLocalVideo(scanned, stored) {
  const name = String(scanned?.name || "").toLowerCase();
  const size = Number(scanned?.size);
  const modifiedAt = Date.parse(scanned?.modifiedAt || scanned?.modified_at || "");
  const storedModifiedAt = Date.parse(stored?.modifiedAt || stored?.modified_at || "");
  return Boolean(name)
    && name === String(stored?.name || "").toLowerCase()
    && Number.isSafeInteger(size) && size > 0 && size === Number(stored?.size)
    && Number.isFinite(modifiedAt) && Number.isFinite(storedModifiedAt)
    && Math.abs(modifiedAt - storedModifiedAt) <= 1;
}

export function storedVideosMatch(scanned = [], stored = []) {
  return scanned.length > 0 && scanned.every((video) => stored.some((row) => sameLocalVideo(video, row)));
}
