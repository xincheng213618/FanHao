// Display only the actual buffered intervals. A seek can leave gaps between
// ranges, so a single "buffered end" percentage would overstate readiness.
export function createShortVideoBufferedProgress({ container, getPlayer, now = Date.now, intervalMs = 250 }) {
  const scanInterval = Number.isFinite(intervalMs) ? Math.max(0, intervalMs) : 250;
  const nodes = [];
  let previous = null;
  let previousRanges = "";
  let lastScanAt = -Infinity;
  let disposed = false;

  const clear = () => {
    for (const node of nodes) node.remove();
    nodes.length = 0;
    previousRanges = "";
  };

  function readIdentity() {
    try {
      const player = getPlayer?.() || null;
      const value = Number(player?.duration);
      return {
        player,
        duration: Number.isFinite(value) && value > 0 ? value : 0,
        source: String(player?.getAttribute?.("src") || player?.currentSrc || player?.src || ""),
        videoId: String(player?.dataset?.videoId || ""),
        generation: String(player?.dataset?.shortVideoSourceGeneration || "")
      };
    } catch {
      return { player: null, duration: 0, source: "", videoId: "", generation: "" };
    }
  }

  function readRanges(player, duration) {
    const ranges = [];
    try {
      const buffered = player.buffered;
      const length = Number(buffered?.length);
      if (!Number.isFinite(length) || length < 0) return ranges;
      for (let index = 0; index < Math.floor(length); index += 1) {
        try {
          const rawStart = Number(buffered.start(index));
          const rawEnd = Number(buffered.end(index));
          if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) continue;
          const start = Math.max(0, Math.min(duration, rawStart));
          const end = Math.max(0, Math.min(duration, rawEnd));
          if (end > start) ranges.push([start, end]);
        } catch {
          // A media implementation may reject one range while its state is
          // changing. Preserve other independently readable intervals.
        }
      }
    } catch {
      return ranges;
    }
    ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push(range);
    }
    return merged;
  }

  function sync({ force = false } = {}) {
    if (disposed || !container) return false;
    const current = readIdentity();
    const identityChanged = !previous || Object.keys(current).some((key) => current[key] !== previous[key]);
    if (identityChanged) {
      clear();
      previous = current;
    }
    if (!current.player || !current.duration) {
      clear();
      return identityChanged;
    }
    const sampledAt = Number(now());
    const scanAt = Number.isFinite(sampledAt) ? sampledAt : 0;
    if (!force && !identityChanged && scanAt >= lastScanAt && scanAt - lastScanAt < scanInterval) return false;
    lastScanAt = scanAt;
    const ranges = readRanges(current.player, current.duration);
    const key = ranges.map((range) => range.join(":")).join(";");
    if (key === previousRanges) return identityChanged;
    previousRanges = key;
    for (let index = 0; index < ranges.length; index += 1) {
      let node = nodes[index];
      if (!node) {
        node = (container.ownerDocument || document).createElement("span");
        node.className = "short-video-buffered-range";
        nodes.push(node);
        container.append(node);
      }
      const [start, end] = ranges[index];
      const left = `${start / current.duration * 100}%`;
      const width = `${(end - start) / current.duration * 100}%`;
      if (node.style.left !== left) node.style.left = left;
      if (node.style.width !== width) node.style.width = width;
    }
    while (nodes.length > ranges.length) nodes.pop().remove();
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clear();
    previous = null;
    lastScanAt = -Infinity;
  }

  return Object.freeze({ sync, dispose });
}
