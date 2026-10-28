const installations = new WeakMap();
const HEIGHT_PROPERTY = "--fanhao-bottom-nav-height";

export function installBottomLayout({ nav, root = document.documentElement, view = window } = {}) {
  if (!nav || !root?.style) return { refresh() {}, dispose() {} };
  const existing = installations.get(root);
  if (existing?.nav === nav) return existing.api;
  existing?.api.dispose();

  let disposed = false;
  let running = false;
  let epoch = 0;
  let frame = null;
  let observer = null;
  let published = root.style.getPropertyValue(HEIGHT_PROPERTY).trim();
  const savedHeight = /^\d+(?:\.\d+)?px$/u.test(published) ? Number.parseFloat(published) : 0;
  let lastPositive = Number.isFinite(savedHeight) && savedHeight > 0 ? savedHeight : 0;
  const requestFrame = view.requestAnimationFrame?.bind(view) || (callback => view.setTimeout(callback, 0));
  const cancelFrame = view.cancelAnimationFrame?.bind(view) || (id => view.clearTimeout(id));

  function refresh() {
    if (disposed || !running || frame !== null) return;
    const scheduledEpoch = epoch;
    frame = requestFrame(() => {
      if (disposed || !running || scheduledEpoch !== epoch) return;
      frame = null;
      // A transformed border box includes native safe padding, while absolute
      // navigation pickers do not contribute to its height.
      const measured = nav.isConnected && !nav.hidden ? nav.getBoundingClientRect().height : 0;
      if (Number.isFinite(measured) && measured > 0) lastPositive = measured;
      if (!lastPositive) return; // Hidden startup keeps the CSS fallback.
      const next = `${lastPositive}px`;
      if (next === published) return;
      root.style.setProperty(HEIGHT_PROPERTY, next);
      published = next;
    });
  }

  function pause() {
    running = false;
    epoch += 1;
    observer?.disconnect();
    observer = null;
    if (frame !== null) cancelFrame(frame);
    frame = null;
  }

  function resume() {
    if (disposed || running) return;
    running = true;
    const observedEpoch = ++epoch;
    if (typeof view.ResizeObserver === "function") {
      try {
        const currentObserver = new view.ResizeObserver(entries => {
          if (disposed || !running || observedEpoch !== epoch || observer !== currentObserver) return;
          if (entries.some(entry => entry.target === nav)) refresh();
        });
        observer = currentObserver;
        try {
          currentObserver.observe(nav, { box: "border-box" });
        } catch {
          // Older WebViews may support ResizeObserver without its box option.
          currentObserver.observe(nav);
        }
      } catch {
        observer?.disconnect();
        observer = null;
      }
    }
    refresh();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    pause();
    view.removeEventListener("resize", refresh);
    view.removeEventListener("orientationchange", refresh);
    view.removeEventListener("pagehide", pause);
    view.removeEventListener("pageshow", resume);
    if (installations.get(root)?.api === api) installations.delete(root);
  }

  const api = { refresh, dispose };
  installations.set(root, { nav, api });
  view.addEventListener("resize", refresh);
  view.addEventListener("orientationchange", refresh);
  view.addEventListener("pagehide", pause);
  view.addEventListener("pageshow", resume);
  resume();
  return api;
}
