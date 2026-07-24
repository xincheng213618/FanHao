export function createShortVideoGalleryPlayer(dependencies) {
  const {
    api,
    applyVideoOrientation,
    clearPlayerSoundBlocked,
    createIcon,
    currentShortVideoVolume,
    els,
    galleryImageEntries,
    isShortVideoGestureClickBlocked,
    isShortVideoKeyboardControl,
    markPlayerSoundBlocked,
    persistShortVideoWatch,
    revealShortVideoClearScreen,
    setIconButton,
    SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS,
    SHORT_VIDEO_GALLERY_ADVANCE_MS,
    SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY,
    SHORT_VIDEO_GALLERY_GESTURE_HINT_MS,
    showBrowserToast,
    showHeartBurst,
    state,
    toggleShortVideoAction,
    wasClearScreenJustRevealed,
    writeMutedPreference
  } = dependencies;

  function renderGalleryPlayer(video, options = {}) {
    const images = galleryImageEntries(video);
    const ghost = Boolean(options.ghost);
    const stage = options.stage;
    const wrap = document.createElement("div");
    wrap.className = `short-video-gallery-player${ghost ? " is-ghost" : ""}`;
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "图文播放器");
    if (images.length > 1) wrap.setAttribute("aria-description", "左右滑动翻图，上下滑动切换作品");
    wrap.dataset.galleryIndex = "0";
    wrap.dataset.galleryRequestedIndex = "0";
    wrap.dataset.galleryCount = String(images.length);
    wrap.style.setProperty("--short-video-gallery-advance-duration", `${SHORT_VIDEO_GALLERY_ADVANCE_MS}ms`);

    const track = document.createElement("div");
    track.className = "short-video-gallery-track";

    const counter = document.createElement("span");
    counter.className = "short-video-gallery-counter";
    counter.setAttribute("role", "status");
    counter.setAttribute("aria-live", "polite");
    counter.setAttribute("aria-atomic", "true");

    const pager = document.createElement("div");
    pager.className = "short-video-gallery-pager";
    pager.setAttribute("role", "group");
    pager.setAttribute("aria-label", "图集翻页");

    const loadStatus = document.createElement("div");
    loadStatus.className = "short-video-gallery-load-status";
    loadStatus.setAttribute("aria-hidden", "true");
    const loadStatusCopy = document.createElement("span");
    loadStatusCopy.className = "short-video-gallery-load-copy";
    loadStatusCopy.setAttribute("role", "status");
    loadStatusCopy.setAttribute("aria-live", "polite");
    loadStatusCopy.setAttribute("aria-atomic", "true");
    const loadRetry = document.createElement("button");
    loadRetry.type = "button";
    loadRetry.className = "short-video-gallery-load-retry";
    loadRetry.textContent = "重试";
    loadRetry.hidden = true;
    loadStatus.append(loadStatusCopy, loadRetry);

    const gestureHint = document.createElement("div");
    gestureHint.className = "short-video-gallery-gesture-hint";
    gestureHint.setAttribute("aria-hidden", "true");
    gestureHint.textContent = "左右滑动翻图 · 上下滑动切作品";

    const progress = document.createElement("div");
    progress.className = "short-video-gallery-progress";
    progress.setAttribute("role", "tablist");
    progress.setAttribute("aria-label", "图集内容进度");
    const progressButtons = images.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.galleryMediaType = item?.type === "video" ? "video" : "image";
      button.setAttribute("role", "tab");
      const mediaLabel = item?.type === "video" ? "视频" : "图片";
      button.setAttribute("aria-label", `查看第 ${index + 1} 项，共 ${images.length} 项，${mediaLabel}`);
      progress.append(button);
      return button;
    });

    const centerPlay = document.createElement("button");
    centerPlay.type = "button";
    centerPlay.className = "short-video-center-play is-gallery-center-play";
    centerPlay.tabIndex = -1;
    centerPlay.setAttribute("aria-hidden", "true");
    setIconButton(centerPlay, "play", "继续播放图集");

    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "short-video-gallery-nav is-previous";
    previous.append(createIcon("chevronLeft"));
    previous.setAttribute("aria-label", "上一项内容");

    const next = document.createElement("button");
    next.type = "button";
    next.className = "short-video-gallery-nav is-next";
    next.append(createIcon("chevronLeft"));
    next.setAttribute("aria-label", "下一项内容");

    const edgePrevious = document.createElement("button");
    edgePrevious.type = "button";
    edgePrevious.className = "short-video-gallery-edge-nav is-previous";
    edgePrevious.append(createIcon("chevronLeft"));
    edgePrevious.setAttribute("aria-label", "上一项图集内容");
    edgePrevious.title = "上一张（←）";

    const edgeNext = document.createElement("button");
    edgeNext.type = "button";
    edgeNext.className = "short-video-gallery-edge-nav is-next";
    edgeNext.append(createIcon("chevronLeft"));
    edgeNext.setAttribute("aria-label", "下一项图集内容");
    edgeNext.title = "下一张（→）";

    let currentIndex = 0;
    let requestedIndex = 0;
    let currentReady = false;
    let image = null;
    let requestToken = 0;
    let cacheClock = 0;
    let animationTimer = 0;
    let boundaryTimer = 0;
    let loadStatusTimer = 0;
    let loadStatusHideTimer = 0;
    let failedLoadIndex = -1;
    let failedLoadDirection = 0;
    let dragActive = false;
    let dragDirection = 0;
    let dragVisualX = 0;
    let dragPreviewEntry = null;
    let dragPreviewToken = 0;
    let dragSettleTimer = 0;
    let advanceTimer = 0;
    let advanceStartedAt = 0;
    let advanceRemainingMs = SHORT_VIDEO_GALLERY_ADVANCE_MS;
    let advanceEntry = null;
    let videoProgressRaf = 0;
    let galleryVisibilityPaused = false;
    let galleryUserPaused = false;
    let backgroundAudio = null;
    let syncGallerySoundState = () => {};
    let galleryClickTimer = 0;
    let counterMotionTimer = 0;
    let localSoundPollTimer = 0;
    let localSoundPollAttempts = 0;
    let gestureHintTimer = 0;
    let gestureHintShown = false;
    const imageCache = new Map();

    const dismissGalleryGestureHint = () => {
      window.clearTimeout(gestureHintTimer);
      gestureHintTimer = 0;
      gestureHint.classList.remove("is-visible");
    };
    const maybeShowGalleryGestureHint = () => {
      if (ghost || gestureHintShown || images.length <= 1 || !window.matchMedia?.("(max-width: 680px)")?.matches) return;
      let alreadySeen = false;
      try {
        alreadySeen = window.sessionStorage?.getItem(SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY) === "1";
      } catch {}
      if (alreadySeen) return;
      gestureHintShown = true;
      try {
        window.sessionStorage?.setItem(SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY, "1");
      } catch {}
      window.requestAnimationFrame(() => gestureHint.classList.add("is-visible"));
      gestureHintTimer = window.setTimeout(dismissGalleryGestureHint, SHORT_VIDEO_GALLERY_GESTURE_HINT_MS);
    };

    const createGalleryImage = (index) => {
      const mediaType = images[index]?.type === "video" ? "video" : "image";
      const element = document.createElement(mediaType === "video" ? "video" : "img");
      element.className = "short-video-gallery-image";
      if (mediaType === "video") {
        element.muted = true;
        element.playsInline = true;
        element.preload = ghost ? "metadata" : "auto";
        element.setAttribute("aria-label", `${video.title || "图文作品"}，第 ${index + 1} 项视频，共 ${images.length} 项`);
      } else {
        element.alt = `${video.title || "图文作品"}，第 ${index + 1} 张，共 ${images.length} 张`;
        element.decoding = "async";
      }
      element.draggable = false;
      element.dataset.galleryImageIndex = String(index);
      element.dataset.galleryMediaType = mediaType;
      return element;
    };
    const loadImage = (index) => {
      const cached = imageCache.get(index);
      if (cached) {
        cached.lastUsed = ++cacheClock;
        return cached;
      }
      const element = createGalleryImage(index);
      const entry = {
        index,
        mediaType: images[index]?.type === "video" ? "video" : "image",
        image: element,
        status: "loading",
        cancelled: false,
        lastUsed: ++cacheClock,
        promise: null,
        cancel: () => {}
      };
      entry.promise = new Promise((resolve) => {
        let settled = false;
        const finish = async (ready) => {
          if (settled) return;
          settled = true;
          element.removeEventListener(entry.mediaType === "video" ? "canplay" : "load", handleLoad);
          element.removeEventListener("error", handleError);
          if (ready && entry.mediaType === "image" && !entry.cancelled && typeof element.decode === "function") {
            try {
              await element.decode();
            } catch {
              // The load event still proves the image can be displayed.
            }
          }
          if (entry.cancelled) {
            resolve(null);
            return;
          }
          entry.status = ready ? "ready" : "error";
          if (!ready && imageCache.get(index) === entry) imageCache.delete(index);
          resolve(ready ? entry : null);
        };
        const handleLoad = () => finish(true);
        const handleError = () => finish(false);
        entry.cancel = () => {
          if (settled) return;
          entry.cancelled = true;
          element.removeEventListener(entry.mediaType === "video" ? "canplay" : "load", handleLoad);
          element.removeEventListener("error", handleError);
          element.pause?.();
          element.removeAttribute("src");
          settled = true;
          resolve(null);
        };
        element.addEventListener(entry.mediaType === "video" ? "canplay" : "load", handleLoad, { once: true });
        element.addEventListener("error", handleError, { once: true });
        element.src = images[index].url;
        if (entry.mediaType === "video") {
          element.load?.();
          if (element.readyState >= 3) Promise.resolve().then(handleLoad);
        } else if (element.complete && element.naturalWidth) {
          Promise.resolve().then(handleLoad);
        }
      });
      imageCache.set(index, entry);
      return entry;
    };
    const releaseEntry = (entry) => {
      if (!entry || entry.image === image) return false;
      entry.cancelled = true;
      entry.cancel?.();
      entry.image.pause?.();
      entry.image.removeAttribute("src");
      if (imageCache.get(entry.index) === entry) imageCache.delete(entry.index);
      return true;
    };
    const trimImageCache = (keepIndexes = new Set()) => {
      const protectedIndexes = new Set([currentIndex, requestedIndex, ...keepIndexes]);
      const candidates = [...imageCache.values()]
        .filter((entry) => !protectedIndexes.has(entry.index) && entry.image !== image)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      while (imageCache.size > 7 && candidates.length) releaseEntry(candidates.shift());
    };
    const resolveGalleryIndex = (index) => {
      if (!images.length) return 0;
      return ((Number(index) % images.length) + images.length) % images.length;
    };
    const preloadAround = (index, direction = 0) => {
      const offsets = direction > 0 ? [1, 2, -1] : (direction < 0 ? [-1, -2, 1] : [-1, 1, -2, 2]);
      const preloadIndexes = [...new Set(offsets
        .map((offset) => resolveGalleryIndex(index + offset))
        .filter((item) => item !== index))];
      preloadIndexes.forEach((item) => loadImage(item));
      trimImageCache(new Set([index, ...preloadIndexes]));
    };
    const hideLoadStatus = () => {
      window.clearTimeout(loadStatusTimer);
      window.clearTimeout(loadStatusHideTimer);
      wrap.classList.remove("is-image-loading");
      wrap.setAttribute("aria-busy", "false");
      loadStatus.classList.remove("is-visible", "is-error");
      loadStatus.setAttribute("aria-hidden", "true");
      loadStatusCopy.textContent = "";
      loadRetry.hidden = true;
      failedLoadIndex = -1;
      failedLoadDirection = 0;
    };
    const showLoadStatus = (index) => {
      window.clearTimeout(loadStatusTimer);
      window.clearTimeout(loadStatusHideTimer);
      wrap.classList.add("is-image-loading");
      wrap.setAttribute("aria-busy", "true");
      loadStatus.classList.remove("is-visible", "is-error");
      loadStatus.setAttribute("aria-hidden", "true");
      loadRetry.hidden = true;
      loadStatusCopy.textContent = currentReady && currentIndex !== index
        ? `正在载入 ${index + 1}/${images.length}，当前仍显示 ${currentIndex + 1}/${images.length}`
        : `正在载入 ${index + 1}/${images.length}`;
      loadStatusTimer = window.setTimeout(() => {
        if (requestedIndex === index && (!currentReady || currentIndex !== index)) {
          loadStatus.setAttribute("aria-hidden", "false");
          loadStatus.classList.add("is-visible");
        }
      }, 120);
    };
    const showLoadError = (index, direction = 0) => {
      window.clearTimeout(loadStatusTimer);
      window.clearTimeout(loadStatusHideTimer);
      wrap.classList.remove("is-image-loading");
      wrap.setAttribute("aria-busy", "false");
      failedLoadIndex = index;
      failedLoadDirection = direction || Math.sign(index - currentIndex);
      requestedIndex = currentIndex;
      syncRequestedUi();
      loadStatusCopy.textContent = currentReady
        ? `第 ${index + 1} 项暂时无法载入，仍显示 ${currentIndex + 1}/${images.length}`
        : `第 ${index + 1} 项暂时无法载入`;
      loadRetry.hidden = false;
      loadRetry.setAttribute("aria-label", `重试载入第 ${index + 1} 项`);
      loadStatus.setAttribute("aria-hidden", "false");
      loadStatus.classList.add("is-visible", "is-error");
    };
    const animateImage = (direction) => {
      window.clearTimeout(animationTimer);
      if (!image) return;
      image.classList.remove("is-entering-next", "is-entering-previous");
      if (!direction || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
      image.getBoundingClientRect();
      image.classList.add(direction > 0 ? "is-entering-next" : "is-entering-previous");
      animationTimer = window.setTimeout(() => {
        image.classList.remove("is-entering-next", "is-entering-previous");
      }, 260);
    };
    const showBoundary = (direction) => {
      window.clearTimeout(boundaryTimer);
      wrap.classList.remove("is-boundary-start", "is-boundary-end");
      wrap.classList.add(direction < 0 ? "is-boundary-start" : "is-boundary-end");
      boundaryTimer = window.setTimeout(() => {
        wrap.classList.remove("is-boundary-start", "is-boundary-end");
      }, 280);
    };
    const syncCommittedUi = (direction = 0) => {
      const current = images[currentIndex];
      counter.textContent = `${currentIndex + 1}/${images.length}`;
      counter.setAttribute("aria-label", `第 ${currentIndex + 1} 项，共 ${images.length} 项`);
      counter.classList.remove("is-page-next", "is-page-previous");
      window.clearTimeout(counterMotionTimer);
      if (direction && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
        counter.getBoundingClientRect();
        counter.classList.add(direction > 0 ? "is-page-next" : "is-page-previous");
        counterMotionTimer = window.setTimeout(() => {
          counter.classList.remove("is-page-next", "is-page-previous");
        }, 220);
      }
      wrap.dataset.galleryIndex = String(currentIndex);
      wrap.classList.toggle("is-gallery-video-item", current?.type === "video");
      progressButtons.forEach((button, itemIndex) => {
        const active = itemIndex === currentIndex;
        button.classList.toggle("active", active);
        button.classList.toggle("is-past", itemIndex < currentIndex);
        button.setAttribute("aria-selected", String(active));
        if (active) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
      });
      if (current) stage?.style.setProperty("--short-video-cover", `url(${JSON.stringify(current.url)})`);
    };
    const restartProgressTiming = () => {
      const activeButton = progressButtons[currentIndex];
      if (!activeButton) return;
      activeButton.style.setProperty("--short-video-gallery-media-progress", "0");
      activeButton.classList.remove("active");
      activeButton.getBoundingClientRect();
      activeButton.classList.add("active");
    };
    const syncRequestedUi = () => {
      wrap.dataset.galleryRequestedIndex = String(requestedIndex);
      previous.disabled = images.length <= 1;
      next.disabled = images.length <= 1;
      edgePrevious.disabled = images.length <= 1;
      edgeNext.disabled = images.length <= 1;
    };
    const stopVideoProgress = () => {
      if (videoProgressRaf) window.cancelAnimationFrame(videoProgressRaf);
      videoProgressRaf = 0;
    };
    const updateVideoProgress = (entry) => {
      if (!entry || entry.mediaType !== "video") return 0;
      const clip = entry.image;
      const duration = Math.max(0, Number(clip.duration || 0));
      const currentTime = Math.max(0, Number(clip.currentTime || 0));
      const ratio = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
      progressButtons[entry.index]?.style.setProperty("--short-video-gallery-media-progress", String(ratio));
      wrap.dataset.galleryVideoProgress = ratio.toFixed(4);
      return ratio;
    };
    const startVideoProgress = (entry) => {
      stopVideoProgress();
      if (!entry || entry.mediaType !== "video") {
        delete wrap.dataset.galleryVideoProgress;
        return;
      }
      const tick = () => {
        videoProgressRaf = 0;
        updateVideoProgress(entry);
        if (!wrap.isConnected
          || currentIndex !== entry.index
          || entry.image.paused
          || entry.image.ended
          || galleryTimingPaused()) return;
        videoProgressRaf = window.requestAnimationFrame(tick);
      };
      tick();
    };
    const clearAdvance = (options = {}) => {
      window.clearTimeout(advanceTimer);
      advanceTimer = 0;
      advanceStartedAt = 0;
      stopVideoProgress();
      if (options.detachVideo !== false && image?.tagName === "VIDEO") {
        image.onended = null;
        delete wrap.dataset.galleryVideoProgress;
      }
      if (options.reset !== false) {
        advanceRemainingMs = SHORT_VIDEO_GALLERY_ADVANCE_MS;
        advanceEntry = null;
      }
    };
    const galleryTimingPaused = () => galleryVisibilityPaused || galleryUserPaused;
    const syncGalleryPlaybackState = () => {
      const paused = galleryTimingPaused();
      wrap.classList.toggle("is-gallery-timing-paused", paused);
      wrap.dataset.galleryPlaybackPaused = galleryUserPaused ? "1" : "0";
      stage?.classList.toggle("is-paused", galleryUserPaused);
      const centerVisible = Boolean(galleryUserPaused && currentReady && !ghost);
      centerPlay.classList.toggle("is-visible", centerVisible);
      centerPlay.tabIndex = centerVisible ? 0 : -1;
      centerPlay.setAttribute("aria-hidden", String(!centerVisible));
      els.workGrid?.querySelector?.(".short-video-control-bar.is-gallery")?.shortVideoSync?.();
    };
    const startAdvance = (entry, options = {}) => {
      if (!entry || ghost || !wrap.isConnected || galleryTimingPaused() || document.hidden) return;
      if (entry.mediaType === "video") {
        const clip = entry.image;
        if (options.restartVideo !== false) clip.currentTime = 0;
        clip.muted = true;
        clip.onended = () => {
          updateVideoProgress(entry);
          if (images.length > 1 && wrap.isConnected && currentIndex === entry.index) move(1);
        };
        clip.play?.().catch(() => {}).finally(() => startVideoProgress(entry));
        return;
      }
      advanceStartedAt = Date.now();
      advanceTimer = window.setTimeout(() => {
        advanceTimer = 0;
        advanceStartedAt = 0;
        if (wrap.isConnected && currentIndex === entry.index) move(1);
      }, Math.max(0, advanceRemainingMs));
    };
    const scheduleAdvance = (entry) => {
      clearAdvance();
      if (!entry) return;
      advanceEntry = entry;
      galleryVisibilityPaused = document.hidden;
      syncGalleryPlaybackState();
      restartProgressTiming();
      startAdvance(entry);
    };
    const pauseAutoAdvance = (reason = "visibility") => {
      const wasPaused = galleryTimingPaused();
      if (reason === "user") galleryUserPaused = true;
      else galleryVisibilityPaused = true;
      if (!wasPaused && advanceTimer && advanceStartedAt) {
        advanceRemainingMs = Math.max(0, advanceRemainingMs - (Date.now() - advanceStartedAt));
      }
      if (!wasPaused) {
        clearAdvance({ reset: false, detachVideo: false });
        if (advanceEntry?.mediaType === "video") advanceEntry.image.pause?.();
      }
      if (reason === "user") backgroundAudio?.pause?.();
      syncGalleryPlaybackState();
      if (reason === "user") stage?.closest?.(".short-video-browser")?.shortVideoRevealControls?.(1900);
    };
    const resumeAutoAdvance = (reason = "visibility") => {
      if (reason === "user") galleryUserPaused = false;
      else galleryVisibilityPaused = false;
      syncGalleryPlaybackState();
      if (galleryTimingPaused()) return;
      const entry = advanceEntry;
      if (!entry || entry.index !== currentIndex || !currentReady) return;
      startAdvance(entry, { restartVideo: false });
      if (reason === "user" && backgroundAudio) playGallerySound();
      if (reason === "user") stage?.closest?.(".short-video-browser")?.shortVideoRevealControls?.(1900);
    };
    const playGallerySound = async () => {
      if (!backgroundAudio || galleryTimingPaused()) return false;
      try {
        await backgroundAudio.play?.();
        delete wrap.dataset.gallerySoundError;
        syncGallerySoundState();
        return !backgroundAudio.paused;
      } catch (error) {
        wrap.dataset.gallerySoundError = `${String(error?.name || "PlaybackError")}: ${String(error?.message || error || "unknown")}`;
        if (!state.shortVideo.muted) markPlayerSoundBlocked(stage);
        backgroundAudio.muted = true;
        syncGallerySoundState();
        try {
          await backgroundAudio.play?.();
        } catch (mutedError) {
          wrap.dataset.gallerySoundError = `${wrap.dataset.gallerySoundError}; muted retry: ${String(mutedError?.name || "PlaybackError")}: ${String(mutedError?.message || mutedError || "unknown")}`;
          // The environment may block audio playback entirely; keep the blocked state visible.
        }
        syncGallerySoundState();
        return false;
      }
    };
    const restoreGallerySound = async () => {
      if (!backgroundAudio) return "missing";
      state.shortVideo.muted = false;
      writeMutedPreference(false);
      backgroundAudio.muted = false;
      backgroundAudio.volume = currentShortVideoVolume();
      clearPlayerSoundBlocked(stage);
      syncGallerySoundState();
      if (galleryTimingPaused()) return "paused";
      return await playGallerySound() ? "playing" : "blocked";
    };
    const toggleGalleryPlayback = () => {
      if (galleryUserPaused) resumeAutoAdvance("user");
      else pauseAutoAdvance("user");
      return galleryUserPaused;
    };
    centerPlay.addEventListener("pointerdown", (event) => event.stopPropagation());
    centerPlay.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!galleryUserPaused) return;
      resumeAutoAdvance("user");
      stage?.focus?.({ preventScroll: true });
    });
    centerPlay.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const commitImage = (entry, direction = 0, commitOptions = {}) => {
      const nextImage = entry.image;
      clearAdvance();
      if (image && image !== nextImage) {
        image.onended = null;
        image.pause?.();
      }
      nextImage.className = "short-video-gallery-image";
      if (entry.mediaType === "image") {
        nextImage.alt = `${video.title || "图文作品"}，第 ${entry.index + 1} 张，共 ${images.length} 张`;
      }
      track.replaceChildren(nextImage);
      image = nextImage;
      dragActive = false;
      dragDirection = 0;
      dragVisualX = 0;
      dragPreviewEntry = null;
      dragPreviewToken += 1;
      wrap.classList.remove("is-gallery-dragging", "is-gallery-settling");
      track.style.setProperty("--short-video-gallery-drag-x", "0px");
      wrap.dataset.galleryDragX = "0";
      delete wrap.dataset.galleryDragTarget;
      currentIndex = entry.index;
      requestedIndex = entry.index;
      currentReady = true;
      syncCommittedUi(direction);
      syncRequestedUi();
      hideLoadStatus();
      if (commitOptions.animate !== false) animateImage(direction);
      applyVideoOrientation(
        stage?.closest?.(".short-video-reel-panel"),
        stage,
        image.videoWidth || image.naturalWidth,
        image.videoHeight || image.naturalHeight
      );
      if (ghost) trimImageCache(new Set([currentIndex]));
      else preloadAround(currentIndex, direction);
      scheduleAdvance(entry);
      if (!direction) maybeShowGalleryGestureHint();
    };
    const show = (index, direction = 0) => {
      if (!images.length) return;
      if (dragActive || wrap.classList.contains("is-gallery-settling")) return false;
      const nextIndex = Math.max(0, Math.min(images.length - 1, Number(index) || 0));
      const resolvedDirection = direction || Math.sign(nextIndex - requestedIndex) || Math.sign(nextIndex - currentIndex);
      requestedIndex = nextIndex;
      syncRequestedUi();
      const token = ++requestToken;
      if (nextIndex === currentIndex && currentReady) {
        hideLoadStatus();
        preloadAround(currentIndex, resolvedDirection);
        return true;
      }
      showLoadStatus(nextIndex);
      const entry = loadImage(nextIndex);
      if (ghost) trimImageCache(new Set([nextIndex]));
      else preloadAround(nextIndex, resolvedDirection);
      entry.promise.then((readyEntry) => {
        if (token !== requestToken || requestedIndex !== nextIndex || !wrap.isConnected) return;
        if (!readyEntry) {
          showLoadError(nextIndex, resolvedDirection);
          return;
        }
        commitImage(readyEntry, resolvedDirection);
      });
      return true;
    };
    loadRetry.addEventListener("pointerdown", (event) => event.stopPropagation());
    loadRetry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (failedLoadIndex < 0) return;
      show(failedLoadIndex, failedLoadDirection);
    });
    loadRetry.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const clearDragPreview = () => {
      const previewImage = dragPreviewEntry?.image;
      if (previewImage && previewImage !== image) {
        previewImage.classList.remove("is-drag-preview", "is-next", "is-previous");
        previewImage.remove();
      }
      dragPreviewEntry = null;
    };
    const prepareDragPreview = (direction) => {
      const token = ++dragPreviewToken;
      clearDragPreview();
      dragDirection = direction;
      const targetIndex = resolveGalleryIndex(currentIndex + direction);
      wrap.dataset.galleryDragTarget = String(targetIndex);
      const entry = loadImage(targetIndex);
      trimImageCache(new Set([currentIndex, targetIndex]));
      const attach = (readyEntry) => {
        if (!readyEntry || !dragActive || token !== dragPreviewToken || dragDirection !== direction) return;
        if (readyEntry.index !== resolveGalleryIndex(currentIndex + direction)) return;
        const previewImage = readyEntry.image;
        previewImage.className = `short-video-gallery-image is-drag-preview ${direction > 0 ? "is-next" : "is-previous"}`;
        dragPreviewEntry = readyEntry;
        track.append(previewImage);
      };
      if (entry.status === "ready") attach(entry);
      else entry.promise.then(attach);
    };
    const startDrag = () => {
      if (ghost || images.length <= 1 || !currentReady || dragActive || wrap.classList.contains("is-gallery-settling")) return false;
      window.clearTimeout(dragSettleTimer);
      clearAdvance();
      wrap.classList.add("is-gallery-timing-paused");
      requestToken += 1;
      requestedIndex = currentIndex;
      syncRequestedUi();
      hideLoadStatus();
      clearDragPreview();
      dragActive = true;
      dragDirection = 0;
      dragVisualX = 0;
      image?.classList.remove("is-entering-next", "is-entering-previous");
      wrap.classList.add("is-gallery-dragging");
      wrap.dataset.galleryDragX = "0";
      track.style.setProperty("--short-video-gallery-drag-x", "0px");
      return true;
    };
    const updateDrag = (deltaX) => {
      if (!dragActive) return false;
      const rawDelta = Number(deltaX || 0);
      const direction = rawDelta < 0 ? 1 : (rawDelta > 0 ? -1 : 0);
      if (direction && direction !== dragDirection) prepareDragPreview(direction);
      const targetIndex = resolveGalleryIndex(currentIndex + direction);
      const canMove = Boolean(direction && images.length > 1);
      const width = Math.max(1, wrap.clientWidth || stage?.clientWidth || 1);
      const bounded = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), width * 1.06);
      dragVisualX = canMove ? bounded : rawDelta * .22;
      track.style.setProperty("--short-video-gallery-drag-x", `${dragVisualX}px`);
      wrap.dataset.galleryDragX = String(Math.round(dragVisualX));
      return true;
    };
    const settleDrag = (targetX, callback, durationMs = 230) => {
      dragActive = false;
      wrap.classList.remove("is-gallery-dragging");
      wrap.classList.add("is-gallery-settling");
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      const settleDuration = reducedMotion ? 20 : Math.max(120, Math.min(280, Math.round(Number(durationMs) || 230)));
      wrap.style.setProperty("--short-video-gallery-settle-duration", `${settleDuration}ms`);
      wrap.dataset.gallerySettleDuration = String(settleDuration);
      dragVisualX = Number(targetX || 0);
      track.style.setProperty("--short-video-gallery-drag-x", `${dragVisualX}px`);
      wrap.dataset.galleryDragX = String(Math.round(dragVisualX));
      window.clearTimeout(dragSettleTimer);
      dragSettleTimer = window.setTimeout(() => {
        wrap.classList.remove("is-gallery-settling");
        callback?.();
        dragVisualX = 0;
        track.style.setProperty("--short-video-gallery-drag-x", "0px");
        wrap.dataset.galleryDragX = "0";
        delete wrap.dataset.galleryDragTarget;
      }, settleDuration + 10);
    };
    const endDrag = (deltaX, velocityX = 0) => {
      if (!dragActive) return false;
      const rawDelta = Number(deltaX || dragVisualX || 0);
      const velocity = Math.max(-2.4, Math.min(2.4, Number(velocityX || 0)));
      const projectedDelta = rawDelta + velocity * 180;
      const direction = rawDelta < 0 ? 1 : (rawDelta > 0 ? -1 : (velocity < 0 ? 1 : (velocity > 0 ? -1 : dragDirection)));
      const targetIndex = resolveGalleryIndex(currentIndex + direction);
      const canMove = Boolean(direction && images.length > 1);
      const width = Math.max(1, wrap.clientWidth || stage?.clientWidth || 1);
      const distanceReady = Math.abs(rawDelta) >= Math.min(120, width * .22);
      const projectedReady = Math.abs(projectedDelta) >= Math.min(96, width * .18)
        && Math.sign(projectedDelta) === Math.sign(rawDelta || projectedDelta);
      const velocityReady = Math.abs(velocity) >= .45
        && Math.sign(velocity) === Math.sign(rawDelta)
        && Math.abs(rawDelta) >= 18;
      const shouldCommit = Boolean(canMove && (distanceReady || projectedReady || velocityReady));
      const readyEntry = dragPreviewEntry?.index === targetIndex && dragPreviewEntry.status === "ready"
        ? dragPreviewEntry
        : null;
      if (shouldCommit && readyEntry) {
        const settleX = direction > 0 ? -width : width;
        const remainingRatio = Math.min(1, Math.abs(settleX - rawDelta) / width);
        const settleDuration = 220 + remainingRatio * 42 - Math.min(92, Math.abs(velocity) * 58);
        settleDrag(settleX, () => commitImage(readyEntry, direction, { animate: false }), settleDuration);
        return true;
      }
      const reboundDuration = 148 + Math.min(72, Math.abs(rawDelta) / width * 90) - Math.min(28, Math.abs(velocity) * 18);
      settleDrag(0, () => {
        clearDragPreview();
        dragDirection = 0;
        if (shouldCommit) show(targetIndex, direction);
        else scheduleAdvance(imageCache.get(currentIndex));
      }, reboundDuration);
      return true;
    };
    const cancelDrag = () => {
      if (!dragActive) return false;
      settleDrag(0, () => {
        clearDragPreview();
        dragDirection = 0;
        scheduleAdvance(imageCache.get(currentIndex));
      });
      return true;
    };
    const move = (delta) => {
      const direction = Math.sign(Number(delta) || 0);
      if (!direction) return false;
      const nextIndex = resolveGalleryIndex(requestedIndex + direction);
      return Boolean(show(nextIndex, direction));
    };
    wrap.shortVideoGalleryMove = move;
    wrap.shortVideoGalleryDragStart = startDrag;
    wrap.shortVideoGalleryDragMove = updateDrag;
    wrap.shortVideoGalleryDragEnd = endDrag;
    wrap.shortVideoGalleryDragCancel = cancelDrag;
    wrap.shortVideoGalleryPause = pauseAutoAdvance;
    wrap.shortVideoGalleryResume = resumeAutoAdvance;
    wrap.shortVideoGalleryTogglePlayback = toggleGalleryPlayback;
    wrap.shortVideoGalleryIsPaused = () => galleryUserPaused;
    wrap.shortVideoGalleryPlaySound = playGallerySound;
    wrap.shortVideoGalleryRestoreSound = restoreGallerySound;
    progressButtons.forEach((button, index) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        show(index, Math.sign(index - requestedIndex));
      });
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
    });
    const stopAndMove = (delta) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      move(delta);
    };
    previous.addEventListener("click", stopAndMove(-1));
    next.addEventListener("click", stopAndMove(1));
    edgePrevious.addEventListener("click", stopAndMove(-1));
    edgeNext.addEventListener("click", stopAndMove(1));
    previous.addEventListener("pointerdown", (event) => event.stopPropagation());
    next.addEventListener("pointerdown", (event) => event.stopPropagation());
    edgePrevious.addEventListener("pointerdown", (event) => event.stopPropagation());
    edgeNext.addEventListener("pointerdown", (event) => event.stopPropagation());
    if (!ghost) {
      wrap.addEventListener("pointerdown", dismissGalleryGestureHint, { passive: true });
      window.requestAnimationFrame(() => {
        persistShortVideoWatch(video, null, { force: true, completed: true });
      });
      stage?.addEventListener("dblclick", (event) => {
        window.clearTimeout(galleryClickTimer);
        galleryClickTimer = 0;
        if (wasClearScreenJustRevealed(stage) || isShortVideoGestureClickBlocked(stage)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        toggleShortVideoAction(state.shortVideo?.current, "like", options.railGetter?.(), { forceActive: true, silent: true });
        showHeartBurst(stage, event);
      });
      wrap.addEventListener("click", (event) => {
        if (isShortVideoKeyboardControl(event.target)) return;
        if (revealShortVideoClearScreen(wrap) || wasClearScreenJustRevealed(wrap)) return;
        if (isShortVideoGestureClickBlocked(wrap)) return;
        if (stage?.classList.contains("is-sound-blocked") && backgroundAudio) {
          window.clearTimeout(galleryClickTimer);
          galleryClickTimer = 0;
          restoreGallerySound().then((result) => {
            if (result === "playing") showBrowserToast("图集音乐已开启");
            else if (result === "paused") showBrowserToast("图集音乐已开启，继续播放图集后生效");
            else showBrowserToast("浏览器仍在阻止音乐播放，请再次点击声音按钮");
          });
          return;
        }
        const browser = wrap.closest(".short-video-browser");
        if (browser?.dataset?.shortVideoTapReveal === "1") {
          delete browser.dataset.shortVideoTapReveal;
          return;
        }
        window.clearTimeout(galleryClickTimer);
        galleryClickTimer = window.setTimeout(() => {
          galleryClickTimer = 0;
          toggleGalleryPlayback();
        }, SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS);
      });
    }
    const initialEntry = loadImage(0);
    image = initialEntry.image;
    track.append(image);
    if (images.length > 1) pager.append(previous, counter, next);
    else pager.append(counter);
    wrap.append(track, progress, pager);
    if (images.length > 1) wrap.append(edgePrevious, edgeNext);
    wrap.append(centerPlay, loadStatus, gestureHint);
    const attachLocalBackgroundSound = (sound = video.sound) => {
      const localSoundUrl = !ghost && sound?.localAvailable ? String(sound.previewUrl || "").trim() : "";
      if (!localSoundUrl || backgroundAudio) return false;
      const audio = document.createElement("audio");
      audio.className = "short-video-player short-video-gallery-audio";
      audio.src = localSoundUrl;
      audio.dataset.streamUrl = localSoundUrl;
      audio.loop = true;
      audio.autoplay = true;
      audio.preload = "auto";
      audio.muted = Boolean(state.shortVideo.muted);
      audio.volume = currentShortVideoVolume();
      backgroundAudio = audio;
      video.sound = sound;
      if (state.shortVideo?.current?.id === video.id) state.shortVideo.current.sound = sound;
      wrap.append(audio);
      syncGallerySoundState = () => {
        const playing = !audio.paused && !audio.ended;
        const muted = Boolean(audio.muted || audio.volume <= 0);
        const blocked = Boolean(stage?.classList.contains("is-sound-blocked"));
        const soundState = blocked ? "blocked" : (playing ? "playing" : "paused");
        const audible = Boolean(playing && !muted && !blocked);
        wrap.dataset.gallerySoundState = soundState;
        wrap.dataset.gallerySoundMuted = muted ? "1" : "0";
        const railSound = options.railGetter?.()?.querySelector?.(".short-video-rail-button.is-listen");
        railSound?.classList.toggle("is-playing", audible);
        railSound?.classList.toggle("is-muted", muted);
        railSound?.classList.toggle("is-blocked", blocked);
        els.workGrid?.querySelector?.(".short-video-control-bar.is-gallery")?.shortVideoSync?.();
      };
      audio.addEventListener("play", syncGallerySoundState);
      audio.addEventListener("pause", syncGallerySoundState);
      audio.addEventListener("ended", syncGallerySoundState);
      audio.addEventListener("volumechange", syncGallerySoundState);
      audio.addEventListener("error", syncGallerySoundState);
      els.workGrid?.querySelector?.(".short-video-control-bar.is-gallery")?.shortVideoEnableGallerySound?.(sound);
      window.requestAnimationFrame(() => {
        if (galleryUserPaused) {
          syncGallerySoundState();
          return;
        }
        playGallerySound();
        syncGallerySoundState();
      });
      return true;
    };
    const refreshLocalBackgroundSound = async () => {
      if (backgroundAudio) return true;
      if (!video.sound?.previewUrl || localSoundPollAttempts >= 48) return false;
      localSoundPollAttempts += 1;
      const params = new URLSearchParams({
        source: "all",
        neighbors: "1",
        metadata: "1",
        refresh: String(Date.now())
      });
      const data = await api(`/api/short-videos/${encodeURIComponent(video.id)}?${params}`);
      const sound = data?.video?.sound;
      return Boolean(sound?.localAvailable && sound.previewUrl && attachLocalBackgroundSound(sound));
    };
    const scheduleLocalSoundPoll = (delayMs = 15000) => {
      window.clearTimeout(localSoundPollTimer);
      if (ghost || backgroundAudio || !video.sound?.previewUrl || localSoundPollAttempts >= 48) return;
      localSoundPollTimer = window.setTimeout(async () => {
        localSoundPollTimer = 0;
        if (!wrap.isConnected || backgroundAudio) return;
        try {
          if (await refreshLocalBackgroundSound()) return;
        } catch {
          // The downloader or local sync may still be replacing its database row.
        }
        scheduleLocalSoundPoll();
      }, Math.max(0, Number(delayMs || 0)));
    };
    wrap.shortVideoGalleryRefreshSound = async () => {
      window.clearTimeout(localSoundPollTimer);
      localSoundPollTimer = 0;
      try {
        if (await refreshLocalBackgroundSound()) return true;
      } catch {
        // Keep the background retry alive when a manual refresh races the downloader.
      }
      scheduleLocalSoundPoll();
      return false;
    };
    if (!attachLocalBackgroundSound(video.sound)) scheduleLocalSoundPoll(0);
    syncCommittedUi();
    syncRequestedUi();
    show(0);
    return wrap;
  }

  return renderGalleryPlayer;
}
