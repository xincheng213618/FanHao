export const NOVEL_AUTO_SCROLL_SPEEDS = Object.freeze({ slow: 24, normal: 42, fast: 66 });

export function createNovelAutoScroll(onChange) {
  let session = null;
  let frame = null;

  function stop(reason) {
    if (!session) return false;
    session = null;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    onChange(false, reason);
    return true;
  }

  function advance(owner, now) {
    if (session !== owner) return;
    frame = null;
    if (!owner.isCurrent() || document.hidden) { stop(); return; }
    const top = window.scrollY;
    if (owner.expectedTop !== null && Math.abs(top - owner.expectedTop) > 1) { stop("pause"); return; }
    const end = owner.end();
    if (end - top <= 1) {
      if (end > top) window.scrollTo({ top: end, behavior: "instant" });
      stop("end");
      return;
    }
    if (owner.last !== null) {
      const elapsed = Math.max(0, Math.min(80, now - owner.last));
      owner.remainder += owner.speed * elapsed / 1000;
      const pixels = Math.floor(owner.remainder);
      if (pixels) {
        owner.remainder -= pixels;
        window.scrollTo({ top: Math.min(top + pixels, end), behavior: "instant" });
      }
    }
    owner.last = now;
    owner.expectedTop = window.scrollY;
    frame = window.requestAnimationFrame(next => advance(owner, next));
  }

  function start({ isCurrent, end, speed }) {
    if (session || document.hidden || !isCurrent()) return false;
    const owner = { isCurrent, end, speed, last: null, remainder: 0, expectedTop: null };
    session = owner;
    frame = window.requestAnimationFrame(now => advance(owner, now));
    onChange(true);
    return true;
  }

  return { start, stop, isRunning: () => session !== null };
}
