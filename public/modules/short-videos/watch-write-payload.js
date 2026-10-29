export function mergeShortVideoWatchPayload(pending, latest) {
  const progressMs = Number(latest?.progressMs);
  return {
    progressMs: Number.isFinite(progressMs) ? Math.max(0, Math.round(progressMs)) : 0,
    completed: Boolean(pending?.completed || latest?.completed)
  };
}
