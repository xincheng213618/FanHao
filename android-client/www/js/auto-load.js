const AUTO_LOAD_ROOT_MARGIN = "0px 0px 1600px 0px";
const FALLBACK_AUTO_LOAD_DISTANCE = 1600;
const AUTO_LOAD_RECHECK_DELAYS = [120, 420, 900];

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

  const check = () => {
    if (!node.isConnected) {
      cleanup();
      return;
    }
    const rect = node.getBoundingClientRect();
    if (rect.top <= window.innerHeight + FALLBACK_AUTO_LOAD_DISTANCE && rect.bottom >= -FALLBACK_AUTO_LOAD_DISTANCE) run();
  };

  scheduleCheck = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      check();
    });
  };

  const bindScrollCheck = () => {
    window.addEventListener("scroll", scheduleCheck, { passive: true });
    window.addEventListener("resize", scheduleCheck, { passive: true });
    window.setTimeout(check, 120);
    window.setTimeout(check, 700);
  };

  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) run();
    }, {
      root: null,
      rootMargin: options.rootMargin || AUTO_LOAD_ROOT_MARGIN,
      threshold: 0
    });
    observer.observe(node);
    bindScrollCheck();
    cleanup = () => {
      observer?.disconnect();
      window.removeEventListener("scroll", scheduleCheck);
      window.removeEventListener("resize", scheduleCheck);
    };
    return node;
  }

  bindScrollCheck();
  cleanup = () => {
    window.removeEventListener("scroll", scheduleCheck);
    window.removeEventListener("resize", scheduleCheck);
  };
  return node;
}
