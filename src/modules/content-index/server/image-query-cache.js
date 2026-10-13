export const IMAGE_QUERY_CACHE_MAX_AGE_MS = 30000;
export const IMAGE_QUERY_CACHE_MAX_ROWS = 12000;
export const IMAGE_QUERY_CACHE_MAX_BYTES = 16 * 1024 * 1024;

// One query only. The serialized weight bounds retained content, not JS heap.
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
    if (plan.items.length > IMAGE_QUERY_CACHE_MAX_ROWS) return false;
    try {
      let bytes = 32 + Buffer.byteLength(key) + Buffer.byteLength(stamp) + Buffer.byteLength(JSON.stringify(plan.header));
      if (bytes > IMAGE_QUERY_CACHE_MAX_BYTES) return false;
      for (const item of plan.items) {
        bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes > IMAGE_QUERY_CACHE_MAX_BYTES) return false;
      }
      entry = { key, stamp, plan, createdAt: now() };
      return true;
    } catch { return false; }
  }
  return { clear, get, set };
}
