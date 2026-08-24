const CACHE_KEY = "fanhao.shortVideo.likeDistribution.v2";
const CACHE_FRESH_MS = 30 * 60 * 1000;

export function readLikeDistributionCache(currentValue) {
  if (currentValue) return { data: currentValue, restored: false, fresh: true };
  try {
    const cached = JSON.parse(window.localStorage.getItem(CACHE_KEY) || "null");
    if (!cached?.data || typeof cached.data !== "object") return { data: null, restored: false, fresh: false };
    const savedAt = Number(cached.savedAt || 0);
    return {
      data: cached.data,
      restored: true,
      fresh: savedAt > 0 && Date.now() - savedAt < CACHE_FRESH_MS
    };
  } catch {
    return { data: null, restored: false, fresh: false };
  }
}

export function writeLikeDistributionCache(data) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {}
}

export function invalidateLikeDistributionCache() {
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {}
}
