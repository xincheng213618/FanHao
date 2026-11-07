export const IMAGE_QUERY_CACHE_MAX_AGE_MS = 30000;
export const IMAGE_QUERY_CACHE_MAX_ROWS = 12000;
export const IMAGE_QUERY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const IMAGE_QUERY_CACHE_MAX_COMPACT_PHOTO_ROWS = 65536;

// One query only. Budget for retained content and borrowed catalog references.
export function createImageQueryCache({ now = () => Date.now() } = {}) {
  let entry = null;
  function clear() { entry = null; }
  function get(key, stamp) {
    const age = entry ? now() - entry.createdAt : 0;
    if (!entry || entry.key !== key || entry.stamp !== stamp || age < 0 || age >= IMAGE_QUERY_CACHE_MAX_AGE_MS) {
      clear();
      return null;
    }
    return entry.plan;
  }
  function set(key, stamp, plan) {
    clear();
    const compactPhotoPlan = plan.matchMasks || plan.collectionLabels || plan.compactAlbumRows;
    const rowLimit = compactPhotoPlan ? IMAGE_QUERY_CACHE_MAX_COMPACT_PHOTO_ROWS : IMAGE_QUERY_CACHE_MAX_ROWS;
    if (plan.items.length > rowLimit) return false;
    try {
      let bytes = 32 + Buffer.byteLength(key) + Buffer.byteLength(stamp) + Buffer.byteLength(JSON.stringify(plan.header));
      if (bytes > IMAGE_QUERY_CACHE_MAX_BYTES) return false;
      if (compactPhotoPlan) {
        // The photo catalog owns the rows and labels. Budget for the references,
        // search masks, and the sparse map for missing collection labels.
        bytes += plan.items.length * 8 + (plan.matchMasks?.byteLength || 0) + (plan.collectionLabels?.size || 0) * 32;
        if (bytes > IMAGE_QUERY_CACHE_MAX_BYTES) return false;
      } else {
        for (const item of plan.items) {
          bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
          if (bytes > IMAGE_QUERY_CACHE_MAX_BYTES) return false;
        }
      }
      entry = { key, stamp, plan, createdAt: now() };
      return true;
    } catch { return false; }
  }
  return { clear, get, set };
}
