export function syncRenderedVideoCardMetric(card, metric, video, iconFactory, countFormatter) {
  if (!card || !metric || !video) return;
  const liked = Boolean(video.actions?.liked);
  const likes = Math.max(0, Number(video.stats?.likes || 0));
  const count = countFormatter(Number.isFinite(likes) ? likes : 0);
  const stateLabel = `${liked ? "已点赞" : "未点赞"}，${count} 个赞`;
  metric.classList.toggle("is-liked", liked);
  metric.replaceChildren(iconFactory(liked ? "heart" : "heartOutline"), document.createTextNode(count));
  metric.setAttribute("aria-label", stateLabel);
  const openLabel = card.dataset.openLabel || "打开短视频";
  card.setAttribute("aria-label", `${openLabel}，${stateLabel}`);
}

export function refreshRenderedVideoCards(root, video, iconFactory, countFormatter) {
  const videoId = String(video?.id || "").trim();
  if (!root || !videoId) return 0;
  let refreshed = 0;
  for (const wrap of root.querySelectorAll(".short-video-mobile-card-wrap[data-video-id]")) {
    if (wrap.dataset.videoId !== videoId) continue;
    const card = wrap.querySelector(".short-video-mobile-card");
    const metric = wrap.querySelector(".short-video-mobile-thumb-metric");
    if (!card || !metric) continue;
    syncRenderedVideoCardMetric(card, metric, video, iconFactory, countFormatter);
    refreshed += 1;
  }
  return refreshed;
}
