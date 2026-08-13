export function mergeShortVideoWatchPayload(pending, latest) {
  return {
    progressMs: Number(latest?.progressMs || 0),
    completed: Boolean(pending?.completed || latest?.completed)
  };
}
