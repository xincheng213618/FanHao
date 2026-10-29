export function createNovelListReturnRestore({ grid, anchor, isCurrent, onFinish }) {
  const controller = new AbortController();
  let restoring = false;
  let frame = null;
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    if (frame !== null) window.cancelAnimationFrame(frame);
    onFinish?.();
  };
  const noteIntent = event => {
    if (restoring || (event.type === "focusin" && event.target === document.body)) return;
    abort();
  };
  for (const type of ["pointerdown", "keydown", "wheel", "touchmove", "focusin"]) {
    document.addEventListener(type, noteIntent, { capture: true, passive: true, signal: controller.signal });
  }
  window.addEventListener("pagehide", abort, { once: true, signal: controller.signal });

  const restore = () => {
    if (controller.signal.aborted || !isCurrent() || !grid.isConnected) { abort(); return; }
    const home = grid.querySelector(".novel-home");
    if (!home) { abort(); return; }
    const entries = [...home.querySelectorAll("[data-novel-book-key]")];
    const original = entries.find(entry => entry.dataset.novelBookKey === anchor.key);
    const entry = anchor.resume ? home.querySelector(".novel-resume")
      : original || entries[Math.max(0, Math.min(anchor.index, entries.length - 1))];
    const target = entry || home.querySelector("h1, h2") || home;
    const rect = target.getBoundingClientRect();
    const available = window.innerHeight - rect.height;
    const top = entry ? Math.min(Math.max(anchor.top, Math.min(0, available)), Math.max(0, available)) : 0;
    restoring = true;
    window.scrollBy({ top: rect.top - top, behavior: "auto" });
    if (anchor.focus && document.activeElement === document.body) {
      const selector = ["primary", "novel-read-link"].includes(anchor.focusClass)
        ? ".novel-book-actions button:last-child" : `.${CSS.escape(anchor.focusClass || "novel-book-title")}`;
      const focus = (original && anchor.focusClass ? entry?.querySelector(selector)
        : entry?.matches("button, [tabindex]") ? entry
          : null) || entry?.querySelector(".novel-book-title, .novel-ranking-book, button") || target;
      if (focus) {
        if (!focus.matches("button, a, input, select, textarea, [tabindex]")) focus.tabIndex = -1;
        focus.focus({ preventScroll: true });
      }
    }
    restoring = false;
    return { home, target };
  };
  return {
    abort,
    restore() {
      const initial = restore();
      if (!initial) return;
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (initial.home === grid.querySelector(".novel-home") && initial.target.isConnected) restore();
          abort();
        });
      });
    }
  };
}
