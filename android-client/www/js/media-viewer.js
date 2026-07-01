export function createMediaViewer() {
  const AUTO_HIDE_MS = 2500;
  const SWIPE_THRESHOLD = 46;
  const SWIPE_DOMINANCE = 1.15;
  let overlay = null;
  let lastFocused = null;
  let viewerState = null;
  let touchStartX = 0;
  let touchStartY = 0;
  let controlsVisible = true;
  let controlsHideTimer = 0;
  let isScrubbing = false;
  let suppressNextClick = false;
  let suppressClickTimer = 0;
  let swipeTracking = false;

  function bindImageTrigger(element, imageUrl, title = "") {
    if (!element || !imageUrl) return;
    element.classList.add("image-view-trigger");
    element.setAttribute("role", "button");
    element.tabIndex = 0;
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      openImage(imageUrl, title);
    });
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openImage(imageUrl, title);
    });
  }

  function openImage(imageUrl, title = "", options = {}) {
    if (!imageUrl) return false;
    close();
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    viewerState = createViewerState(imageUrl, title, options);

    overlay = document.createElement("div");
    overlay.className = "media-viewer";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    const shell = document.createElement("div");
    shell.className = "media-viewer-shell";

    const head = document.createElement("div");
    head.className = "media-viewer-head";
    const caption = document.createElement("strong");
    const counter = document.createElement("span");
    counter.className = "media-viewer-count";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "media-viewer-close";
    closeButton.setAttribute("aria-label", "关闭");
    closeButton.textContent = "×";
    closeButton.addEventListener("click", close);
    head.append(caption, counter, closeButton);

    const stage = document.createElement("div");
    stage.className = "media-viewer-stage";

    const img = document.createElement("img");
    const prev = createNavButton("上一张", "prev");
    const next = createNavButton("下一张", "next");
    prev.addEventListener("click", (event) => {
      event.stopPropagation();
      showRelativeImage(-1);
    });
    next.addEventListener("click", (event) => {
      event.stopPropagation();
      showRelativeImage(1);
    });
    stage.addEventListener("click", (event) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      if (event.target instanceof Element && event.target.closest(".media-viewer-nav")) return;
      toggleControls();
    });
    bindStageSwipe(stage);
    stage.append(img, prev, next);

    const controlBar = document.createElement("div");
    controlBar.className = "media-viewer-control-bar";
    const progressRow = document.createElement("div");
    progressRow.className = "media-viewer-progress-row";
    const progressTitle = document.createElement("span");
    progressTitle.className = "media-viewer-progress-title";
    progressTitle.textContent = "图片位置";
    const progressValue = document.createElement("span");
    progressValue.className = "media-viewer-progress-value";
    progressRow.append(progressTitle, progressValue);

    const progress = document.createElement("input");
    progress.type = "range";
    progress.className = "media-viewer-range";
    progress.min = "1";
    progress.step = "1";
    progress.setAttribute("aria-label", "跳转图片");
    progress.addEventListener("click", (event) => event.stopPropagation());
    progress.addEventListener("pointerdown", handleScrubStart);
    progress.addEventListener("pointermove", handleScrubMove);
    progress.addEventListener("pointerup", handleScrubEnd);
    progress.addEventListener("pointercancel", handleScrubEnd);
    progress.addEventListener("touchstart", handleScrubStart, { passive: false });
    progress.addEventListener("touchmove", handleScrubMove, { passive: false });
    progress.addEventListener("touchend", handleScrubEnd);
    progress.addEventListener("touchcancel", handleScrubEnd);
    progress.addEventListener("input", () => {
      if (isScrubbing) updateScrubPreview(Number(progress.value) - 1);
      else showImageAt(Number(progress.value) - 1, { keepControls: true });
    });
    progress.addEventListener("change", commitScrub);
    controlBar.append(progressRow, progress);

    shell.append(stage, head, controlBar);
    overlay.append(shell);
    document.body.append(overlay);
    document.body.classList.add("media-viewer-open");
    renderCurrentImage();
    setControlsVisible(true);
    if (!window.matchMedia?.("(pointer: coarse)")?.matches) {
      closeButton.focus({ preventScroll: true });
    }
    return true;
  }

  function createViewerState(imageUrl, title = "", options = {}) {
    const items = normalizeViewerItems(options.items);
    const fallback = { url: imageUrl, title };
    const list = items.length ? items : [fallback];
    const requestedIndex = Number(options.index);
    const matchedIndex = list.findIndex((item) => item.url === imageUrl);
    const index = Number.isFinite(requestedIndex) && requestedIndex >= 0
      ? Math.min(list.length - 1, requestedIndex)
      : Math.max(0, matchedIndex);
    return { items: list, index, sourceKey: String(options.sourceKey || "") };
  }

  function normalizeViewerItems(items = []) {
    return Array.isArray(items)
      ? items
          .map((item) => ({
            url: typeof item === "string" ? item : item?.url,
            title: typeof item === "string" ? "" : item?.title || item?.name || ""
          }))
          .filter((item) => item.url)
      : [];
  }

  function updateItems(items = [], options = {}) {
    if (!overlay || !viewerState) return false;
    if (options.sourceKey && viewerState.sourceKey !== String(options.sourceKey)) return false;

    const list = normalizeViewerItems(items);
    if (!list.length) return false;

    const current = viewerState.items[viewerState.index] || {};
    const requestedIndex = Number(options.index);
    const matchedIndex = current.url ? list.findIndex((item) => item.url === current.url) : -1;
    const index = Number.isFinite(requestedIndex) && requestedIndex >= 0
      ? Math.min(list.length - 1, requestedIndex)
      : matchedIndex >= 0
        ? matchedIndex
        : Math.min(viewerState.index, list.length - 1);

    viewerState = {
      items: list,
      index,
      sourceKey: viewerState.sourceKey
    };
    isScrubbing = false;
    renderCurrentImage();
    if (options.keepControls || controlsVisible) setControlsVisible(true);
    return true;
  }

  function createNavButton(label, direction) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `media-viewer-nav ${direction}`;
    button.setAttribute("aria-label", label);
    button.textContent = direction === "prev" ? "‹" : "›";
    return button;
  }

  function renderCurrentImage() {
    if (!overlay || !viewerState) return;
    const item = viewerState.items[viewerState.index];
    const img = overlay.querySelector(".media-viewer-stage img");
    const caption = overlay.querySelector(".media-viewer-head strong");
    const counter = overlay.querySelector(".media-viewer-count");
    const progress = overlay.querySelector(".media-viewer-range");
    const progressValue = overlay.querySelector(".media-viewer-progress-value");
    if (!img || !item) return;
    img.alt = item.title || "";
    img.src = item.url;
    if (caption) caption.textContent = item.title || "图片";
    if (counter) counter.textContent = `${viewerState.index + 1} / ${viewerState.items.length}`;
    if (progress) {
      progress.max = String(viewerState.items.length);
      progress.value = String(viewerState.index + 1);
      progress.disabled = viewerState.items.length <= 1;
    }
    if (progressValue) progressValue.textContent = `第 ${viewerState.index + 1} / ${viewerState.items.length} 张`;
    overlay.querySelector(".media-viewer-nav.prev")?.toggleAttribute("disabled", viewerState.items.length <= 1 || viewerState.index <= 0);
    overlay.querySelector(".media-viewer-nav.next")?.toggleAttribute("disabled", viewerState.items.length <= 1 || viewerState.index >= viewerState.items.length - 1);
    preloadNearbyImages();
  }

  function showImageAt(index, options = {}) {
    if (!viewerState) return false;
    const nextIndex = Math.trunc(Number(index));
    if (!Number.isFinite(nextIndex)) return false;
    if (nextIndex < 0 || nextIndex >= viewerState.items.length) return false;
    viewerState.index = nextIndex;
    renderCurrentImage();
    if (options.keepControls || controlsVisible) setControlsVisible(true);
    return true;
  }

  function showRelativeImage(delta, options = {}) {
    if (!viewerState) return false;
    return showImageAt(viewerState.index + delta, options);
  }

  function clampViewerIndex(index) {
    if (!viewerState) return 0;
    const nextIndex = Math.trunc(Number(index));
    if (!Number.isFinite(nextIndex)) return viewerState.index;
    return Math.min(Math.max(nextIndex, 0), viewerState.items.length - 1);
  }

  function updateScrubPreview(index) {
    if (!overlay || !viewerState) return false;
    const previewIndex = clampViewerIndex(index);
    const item = viewerState.items[previewIndex] || {};
    const caption = overlay.querySelector(".media-viewer-head strong");
    const counter = overlay.querySelector(".media-viewer-count");
    const progress = overlay.querySelector(".media-viewer-range");
    const progressValue = overlay.querySelector(".media-viewer-progress-value");
    if (caption) caption.textContent = item.title || "图片";
    if (counter) counter.textContent = `${previewIndex + 1} / ${viewerState.items.length}`;
    if (progress) progress.value = String(previewIndex + 1);
    if (progressValue) progressValue.textContent = `第 ${previewIndex + 1} / ${viewerState.items.length} 张`;
    return true;
  }

  function commitScrub() {
    if (!overlay || !viewerState) return false;
    const progress = overlay.querySelector(".media-viewer-range");
    isScrubbing = false;
    return showImageAt(Number(progress?.value || viewerState.index + 1) - 1, { keepControls: true });
  }

  function bindStageSwipe(stage) {
    if (!stage) return;
    if ("PointerEvent" in window) {
      stage.addEventListener("pointerdown", handlePointerSwipeStart);
      stage.addEventListener("pointerup", handlePointerSwipeEnd);
      stage.addEventListener("pointercancel", handlePointerSwipeCancel);
      return;
    }
    stage.addEventListener("touchstart", handleTouchStart, { passive: true });
    stage.addEventListener("touchend", handleTouchEnd);
  }

  function beginSwipeTracking(clientX, clientY, target = null) {
    swipeTracking = false;
    if (target instanceof Element && target.closest(".media-viewer-nav")) return false;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
    touchStartX = clientX;
    touchStartY = clientY;
    swipeTracking = true;
    return true;
  }

  function finishSwipeTracking(clientX, clientY, event = null) {
    if (!swipeTracking) return false;
    swipeTracking = false;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
    const dx = clientX - touchStartX;
    const dy = clientY - touchStartY;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const isHorizontalSwipe = absX >= SWIPE_THRESHOLD && absX >= absY * SWIPE_DOMINANCE;
    const isVerticalSwipe = absY >= SWIPE_THRESHOLD && absY >= absX * SWIPE_DOMINANCE;
    if (!isHorizontalSwipe && !isVerticalSwipe) {
      if (absX < 12 && absY < 12) {
        event?.preventDefault?.();
        suppressSyntheticClick();
        toggleControls();
      }
      return false;
    }
    event?.preventDefault?.();
    suppressSyntheticClick();
    if (isHorizontalSwipe) {
      showRelativeImage(dx < 0 ? 1 : -1);
      return true;
    }
    showRelativeImage(dy < 0 ? 1 : -1);
    return true;
  }

  function handlePointerSwipeStart(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!beginSwipeTracking(Number(event.clientX), Number(event.clientY), event.target)) return;
    event.currentTarget?.setPointerCapture?.(event.pointerId);
  }

  function handlePointerSwipeEnd(event) {
    finishSwipeTracking(Number(event.clientX), Number(event.clientY), event);
    event.currentTarget?.releasePointerCapture?.(event.pointerId);
  }

  function handlePointerSwipeCancel(event) {
    swipeTracking = false;
    event.currentTarget?.releasePointerCapture?.(event.pointerId);
  }

  function handleTouchStart(event) {
    swipeTracking = false;
    if (event.touches?.length > 1) return;
    const touch = event.changedTouches?.[0];
    if (!touch) return;
    beginSwipeTracking(Number(touch.clientX), Number(touch.clientY), event.target);
  }

  function handleTouchEnd(event) {
    const touch = event.changedTouches?.[0];
    if (!touch) return;
    finishSwipeTracking(Number(touch.clientX), Number(touch.clientY), event);
  }

  function handleScrubStart(event) {
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    if (Number.isFinite(event.pointerId)) event.currentTarget?.setPointerCapture?.(event.pointerId);
    isScrubbing = true;
    setControlsVisible(true, false);
    scrubToClientX(getScrubClientX(event));
  }

  function handleScrubMove(event) {
    if (!isScrubbing) return;
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    scrubToClientX(getScrubClientX(event));
  }

  function handleScrubEnd(event) {
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    if (Number.isFinite(event.pointerId)) event.currentTarget?.releasePointerCapture?.(event.pointerId);
    commitScrub();
    setControlsVisible(true);
  }

  function getScrubClientX(event) {
    const touch = event.touches?.[0] || event.changedTouches?.[0];
    return Number(touch?.clientX ?? event.clientX);
  }

  function scrubToClientX(clientX) {
    if (!overlay || !Number.isFinite(clientX)) return false;
    const progress = overlay.querySelector(".media-viewer-range");
    if (!progress) return false;
    const rect = progress.getBoundingClientRect();
    const max = Number(progress.max || 1);
    if (!Number.isFinite(max) || max <= 1 || rect.width <= 0) return false;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const value = Math.round(1 + ratio * (max - 1));
    progress.value = String(value);
    return updateScrubPreview(value - 1);
  }

  function toggleControls() {
    setControlsVisible(!controlsVisible);
  }

  function suppressSyntheticClick() {
    suppressNextClick = true;
    window.clearTimeout(suppressClickTimer);
    suppressClickTimer = window.setTimeout(() => {
      suppressNextClick = false;
    }, 360);
  }

  function setControlsVisible(visible, scheduleHide = true) {
    if (!overlay) return;
    controlsVisible = visible;
    overlay.classList.toggle("media-viewer-controls-hidden", !visible);
    window.clearTimeout(controlsHideTimer);
    if (!visible || !scheduleHide || isScrubbing) return;
    controlsHideTimer = window.setTimeout(() => {
      setControlsVisible(false, false);
    }, AUTO_HIDE_MS);
  }

  function preloadNearbyImages() {
    if (!viewerState) return;
    for (const offset of [1, -1]) {
      const item = viewerState.items[viewerState.index + offset];
      if (!item?.url) continue;
      const image = new Image();
      image.decoding = "async";
      image.src = item.url;
    }
  }

  function close() {
    if (!overlay) return false;
    window.clearTimeout(controlsHideTimer);
    window.clearTimeout(suppressClickTimer);
    overlay.remove();
    overlay = null;
    viewerState = null;
    controlsVisible = true;
    isScrubbing = false;
    suppressNextClick = false;
    swipeTracking = false;
    document.body.classList.remove("media-viewer-open");
    lastFocused?.focus?.({ preventScroll: true });
    lastFocused = null;
    return true;
  }

  function isOpen() {
    return Boolean(overlay);
  }

  window.addEventListener("keydown", (event) => {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      showRelativeImage(event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1, { keepControls: true });
    }
  });

  return {
    bindImageTrigger,
    openImage,
    updateItems,
    close,
    isOpen
  };
}
