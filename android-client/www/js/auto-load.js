const AUTO_LOAD_ROOT_MARGIN = "0px 0px 1600px 0px";
const FALLBACK_AUTO_LOAD_DISTANCE = 1600;
const AUTO_LOAD_RECHECK_DELAYS = [120, 420, 900];
const AUTO_LOAD_SCROLL_INTENT_MS = 1200;

export function enhanceAutoLoadMore(node, handler, options = {}) {
  const button = node instanceof HTMLButtonElement ? node : node.querySelector("button");
  if (!button || typeof handler !== "function") return node;

  const idleText = options.idleText || button.textContent || "继续向下滑动加载";
  const loadingText = options.loadingText || "正在加载更多";
  const retryText = options.retryText || "加载失败，点一下重试";
  let loading = false;
  let cleanup = () => {};
  let scheduleCheck = () => {};

  node.classList.add("auto-load-trigger");
  node.dataset.autoLoad = "ready";
  button.textContent = idleText;
  button.setAttribute("aria-live", "polite");

  const dispose = () => {
    cleanup();
    cleanup = () => {};
  };

  const setReady = () => {
    if (!node.isConnected) {
      dispose();
      return;
    }
    loading = false;
    node.classList.remove("auto-loading");
    node.dataset.autoLoad = "ready";
    button.disabled = false;
    button.textContent = idleText;
    if (options.auto !== false) {
      for (const delay of AUTO_LOAD_RECHECK_DELAYS) window.setTimeout(scheduleCheck, delay);
    }
  };

  const run = async (event = null) => {
    event?.preventDefault();
    if (loading || !node.isConnected) return;
    loading = true;
    node.classList.add("auto-loading");
    node.dataset.autoLoad = "loading";
    button.disabled = true;
    button.textContent = loadingText;

    try {
      await Promise.resolve(handler());
      setReady();
    } catch (error) {
      if (node.isConnected) {
        loading = false;
        node.classList.remove("auto-loading");
        node.dataset.autoLoad = "error";
        button.disabled = false;
        button.textContent = retryText;
        window.setTimeout(scheduleCheck, 900);
      } else {
        dispose();
      }
    }
  };

  button.addEventListener("click", run);

  if (options.auto === false) return node;

  let scheduled = false;
  let observer = null;
  const requireScrollIntent = options.requireScrollIntent === true;
  let userScrollIntentUntil = 0;
  let lastScrollY = window.scrollY;
  let touchScrolling = false;

  const check = () => {
    if (!node.isConnected) {
      cleanup();
      return;
    }
    if (requireScrollIntent && Date.now() > userScrollIntentUntil) return;
    if (requireScrollIntent && touchScrolling) return;
    const rect = node.getBoundingClientRect();
    if (rect.top <= window.innerHeight + FALLBACK_AUTO_LOAD_DISTANCE && rect.bottom >= -FALLBACK_AUTO_LOAD_DISTANCE) {
      if (requireScrollIntent) userScrollIntentUntil = 0;
      run();
    }
  };

  scheduleCheck = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      check();
    });
  };

  const markUserScrollIntent = (event) => {
    if (event.type === "wheel" && Number(event.deltaY || 0) <= 0) return;
    if (event.type === "keydown" && !["ArrowDown", "End", "PageDown", " "].includes(event.key)) return;
    if (event.type === "pointerdown" && Number(event.clientX || 0) < document.documentElement.clientWidth - 20) return;
    userScrollIntentUntil = Date.now() + AUTO_LOAD_SCROLL_INTENT_MS;
  };

  const handleTouchStart = () => {
    touchScrolling = true;
  };

  const handleTouchEnd = () => {
    touchScrolling = false;
    if (requireScrollIntent && Date.now() <= userScrollIntentUntil) window.setTimeout(scheduleCheck, 80);
  };

  const handleScroll = () => {
    const nextScrollY = window.scrollY;
    const movedDown = nextScrollY > lastScrollY + 1;
    lastScrollY = nextScrollY;
    if (requireScrollIntent && (!movedDown || Date.now() > userScrollIntentUntil)) return;
    scheduleCheck();
  };

  const bindScrollCheck = () => {
    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", scheduleCheck, { passive: true });
    if (requireScrollIntent) {
      window.addEventListener("wheel", markUserScrollIntent, { passive: true });
      window.addEventListener("touchstart", handleTouchStart, { passive: true });
      window.addEventListener("touchmove", markUserScrollIntent, { passive: true });
      window.addEventListener("touchend", handleTouchEnd, { passive: true });
      window.addEventListener("touchcancel", handleTouchEnd, { passive: true });
      window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
      window.addEventListener("keydown", markUserScrollIntent);
    } else {
      window.setTimeout(check, 120);
      window.setTimeout(check, 700);
    }
  };

  const unbindScrollCheck = () => {
    window.removeEventListener("scroll", handleScroll);
    window.removeEventListener("resize", scheduleCheck);
    window.removeEventListener("wheel", markUserScrollIntent);
    window.removeEventListener("touchstart", handleTouchStart);
    window.removeEventListener("touchmove", markUserScrollIntent);
    window.removeEventListener("touchend", handleTouchEnd);
    window.removeEventListener("touchcancel", handleTouchEnd);
    window.removeEventListener("pointerdown", markUserScrollIntent);
    window.removeEventListener("keydown", markUserScrollIntent);
  };

  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) scheduleCheck();
    }, {
      root: null,
      rootMargin: options.rootMargin || AUTO_LOAD_ROOT_MARGIN,
      threshold: 0
    });
    observer.observe(node);
    bindScrollCheck();
    cleanup = () => {
      observer?.disconnect();
      unbindScrollCheck();
    };
    return node;
  }

  bindScrollCheck();
  cleanup = unbindScrollCheck;
  return node;
}
