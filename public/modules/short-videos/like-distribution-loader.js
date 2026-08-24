import { writeLikeDistributionCache } from "./like-distribution-cache.js?v=20260825-author-efficiency-01";

export function createLikeDistributionLoader(options = {}) {
  const { api, render, shortVideoState } = options;
  if (typeof api !== "function" || typeof render !== "function" || !shortVideoState) {
    throw new TypeError("like distribution loader dependencies are required");
  }
  let loadPromise = null;

  function loadLikeDistribution(options = {}) {
    if (loadPromise) {
      // A cached page can already be refreshing silently in the background.
      // Promote that request to a visible refresh when the user clicks instead
      // of leaving an enabled button that appears to do nothing.
      if (options.force === true) {
        const shouldRender = !shortVideoState.likeDistributionLoading && shortVideoState.mode === "likes";
        shortVideoState.likeDistributionLoading = true;
        shortVideoState.likeDistributionError = "";
        if (shouldRender) render();
      }
      return loadPromise;
    }
    const silent = options.silent === true && Boolean(shortVideoState.likeDistribution);
    const forceRefresh = options.force === true;
    shortVideoState.likeDistributionLoading = !silent;
    shortVideoState.likeDistributionError = "";
    if (!silent && shortVideoState.mode === "likes") render();
    loadPromise = (async () => {
      try {
        const data = await api(
          forceRefresh ? "/api/short-videos/like-distribution/refresh" : "/api/short-videos/like-distribution",
          forceRefresh ? { method: "POST" } : {}
        );
        shortVideoState.likeDistribution = data;
        writeLikeDistributionCache(data);
        return data;
      } catch (error) {
        if (!silent || !shortVideoState.likeDistribution) {
          shortVideoState.likeDistributionError = error?.message || "点赞分布读取失败";
        }
        return null;
      } finally {
        shortVideoState.likeDistributionLoading = false;
        loadPromise = null;
        if (shortVideoState.mode === "likes" && options.render !== false) render();
      }
    })();
    return loadPromise;
  }

  return { loadLikeDistribution };
}
