export function allowShortVideoSpeculativePrewarm({
  hidden = Boolean(globalThis.document?.hidden),
  connection = globalThis.navigator?.connection,
  currentPlayer = null
} = {}) {
  if (hidden || connection?.saveData || ["slow-2g", "2g"].includes(String(connection?.effectiveType || "").toLowerCase())) return false;
  if (!currentPlayer || currentPlayer.tagName === "AUDIO") return true;
  if (currentPlayer.dataset?.shortVideoFrameReady !== "1") return false;
  if (currentPlayer.closest?.(".short-video-stage")?.classList.contains("is-video-buffering")) return false;
  return currentPlayer.paused || currentPlayer.ended || Number(currentPlayer.readyState) >= 3;
}
