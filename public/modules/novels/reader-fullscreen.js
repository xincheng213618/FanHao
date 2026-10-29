export function createNovelReaderFullscreen({ isReader, captureReader, onChange }) {
  const root = document.documentElement;
  let owned = false;
  let operation = null;
  let exitPromise = null;
  let error = "";

  const supported = () => Boolean(document.fullscreenEnabled && root.requestFullscreen);
  const state = () => ({
    supported: supported(),
    available: supported() && (!document.fullscreenElement || owned),
    active: owned && document.fullscreenElement === root,
    pending: Boolean(operation), error
  });

  async function exitOwned() {
    if (!owned || document.fullscreenElement !== root) return;
    if (!exitPromise) {
      exitPromise = document.exitFullscreen().finally(() => { exitPromise = null; });
    }
    await exitPromise;
  }

  async function leave() {
    const pending = operation;
    if (pending) { pending.cancelled = true; pending.anchor.abort(); }
    try {
      await exitOwned();
      if (pending) await pending.promise;
      await exitOwned();
    } catch {
      // Navigation must remain available; native Esc can still exit a rejected transition.
    }
  }

  function toggle() {
    if (operation || !state().available || !isReader()) return;
    const reader = captureReader();
    if (!reader?.isCurrent()) return;
    const request = { entering: !state().active, cancelled: false, anchor: captureViewport(reader), promise: null };
    operation = request;
    error = "";
    onChange();
    // Invoke the native API in the original click's user activation.
    request.promise = (async () => {
      try {
        if (request.entering) {
          await root.requestFullscreen();
          owned = document.fullscreenElement === root;
          if (request.cancelled || !reader.isCurrent()) { request.anchor.abort(); await exitOwned(); return; }
        } else await exitOwned();
        request.anchor.restore();
      } catch {
        request.anchor.abort();
        if (!request.cancelled && reader.isCurrent()) error = "无法切换全屏，请重试或使用浏览器的全屏功能。";
      } finally {
        if (operation === request) operation = null;
        onChange();
      }
    })();
    return request.promise;
  }

  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement !== root) owned = false;
    else if (operation?.entering) owned = true;
    onChange();
    if (owned && !isReader()) void leave();
  });
  window.addEventListener("pagehide", () => { void leave(); });
  return { state, toggle, leave };
}

function captureViewport({ page, isCurrent }) {
  const paragraphs = page.querySelector(".novel-reader-content")?.children;
  let start = 0, end = paragraphs?.length || 0;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (paragraphs[middle].getBoundingClientRect().bottom <= 0) start = middle + 1;
    else end = middle;
  }
  const paragraph = paragraphs?.[Math.min(start, paragraphs.length - 1)];
  const top = paragraph?.getBoundingClientRect().top;
  const scroll = window.scrollY;
  const controller = new AbortController();
  let frame = null;
  const abort = () => { controller.abort(); if (frame != null) window.cancelAnimationFrame(frame); };
  const intent = event => {
    if (event.type === "focusin" && event.target === document.body) return;
    abort();
  };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "focusin"]) {
    document.addEventListener(type, intent, { capture: true, passive: true, signal: controller.signal });
  }
  return {
    abort,
    restore() {
      const apply = () => {
        if (controller.signal.aborted || !isCurrent() || !page.isConnected) return false;
        if (paragraph?.isConnected) window.scrollBy({ top: paragraph.getBoundingClientRect().top - top, left: 0, behavior: "auto" });
        else window.scrollTo({ top: scroll, left: 0, behavior: "auto" });
        return true;
      };
      if (!apply()) { abort(); return; }
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => { apply(); abort(); });
      });
    }
  };
}
