import { absoluteUrl, loadPreviewImage } from "../../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatBytes, formatCompact } from "../../../js/format.js";
import { DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_SOURCE, formatDate, formatDuration, initials, normalizeSort, normalizeSource } from "../shared.js";
export function createShortVideoInteractions(context = {}) {
  const { browserState, els, goBack, listState } = context;
  const createIcon = (...args) => context.createIcon(...args);
  const isBrowserView = (...args) => context.isBrowserView(...args);
  const openAdjacent = (...args) => context.openAdjacent(...args);
  const restoreAuthorReturnPanel = (...args) => context.restoreAuthorReturnPanel(...args);
  const shortVideoToast = (...args) => context.shortVideoToast(...args);
  const showAuthorPanel = (...args) => context.showAuthorPanel(...args);
  const showPlaybackToolbar = (...args) => context.showPlaybackToolbar(...args);
  const systemPlugin = (...args) => context.systemPlugin(...args);
  function stopPanelMedia(root) {
    for (const media of root?.querySelectorAll?.("video") || []) {
      media.pause?.();
      media.removeAttribute("src");
      media.load?.();
    }
  }

  function activeReelStack() {
    return els.viewContent?.querySelector?.(".short-video-mobile-reel-stack") || null;
  }

  function isHorizontalSwipe(deltaX, deltaY, threshold) {
    return Math.abs(deltaX) >= threshold && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
  }

  function handleHorizontalSwipe(deltaX) {
    if (deltaX > 0) {
      if (restoreAuthorReturnPanel()) return;
      goBack();
      return;
    }
    if (isViewingAuthorFeed()) {
      shortVideoToast("已在作者页，右滑返回");
      return;
    }
    showAuthorPanel(browserState.video);
  }

  function isViewingAuthorFeed() {
    return Boolean(listState.author && listState.author !== "all");
  }

  function startSystemInfoUpdates() {
    stopSystemInfoUpdates();
    updateSystemInfo({ force: true });
    browserState.systemInfoTimer = window.setInterval(() => updateSystemInfo(), 30000);
  }

  function stopSystemInfoUpdates() {
    if (!browserState.systemInfoTimer) return;
    window.clearInterval(browserState.systemInfoTimer);
    browserState.systemInfoTimer = null;
  }

  async function updateSystemInfo(options = {}) {
    if (!options.force && !isBrowserView()) {
      stopSystemInfoUpdates();
      return;
    }

    browserState.systemInfoText = formatSystemStatusText();
    updateSystemInfoNode();

    const nativeInfo = await readNativeStatusInfo();
    if (nativeInfo) {
      browserState.systemInfoText = formatSystemStatusText(nativeInfo);
      updateSystemInfoNode();
      return;
    }

    const batteryInfo = await readWebBatteryInfo();
    if (batteryInfo) {
      browserState.systemInfoText = formatSystemStatusText(batteryInfo);
      updateSystemInfoNode();
    }
  }

  async function readNativeStatusInfo() {
    const plugin = systemPlugin();
    if (!plugin?.getStatusInfo) return null;
    try {
      return await plugin.getStatusInfo();
    } catch {
      return null;
    }
  }

  async function readWebBatteryInfo() {
    if (!navigator.getBattery) return null;
    try {
      const battery = await navigator.getBattery();
      return {
        battery: Math.round(Number(battery.level || 0) * 100),
        charging: Boolean(battery.charging)
      };
    } catch {
      return null;
    }
  }

  function updateSystemInfoNode() {
    const node = els.viewContent?.querySelector?.("[data-short-video-system-info]");
    if (node) node.textContent = browserState.systemInfoText || formatSystemStatusText();
  }

  function formatSystemStatusText(info = {}) {
    const localTime = formatLocalShortTime();
    const time = String(info.time || localTime).trim() || localTime;
    const battery = Number(info.battery);
    const parts = [time];
    if (Number.isFinite(battery) && battery >= 0) {
      parts.push(`电量 ${Math.round(battery)}%`);
    }
    if (info.charging) parts.push("充电");
    return parts.join("  ");
  }

  function formatLocalShortTime() {
    const now = new Date();
    const hour = String(now.getHours()).padStart(2, "0");
    const minute = String(now.getMinutes()).padStart(2, "0");
    return `${hour}:${minute}`;
  }

  function applyDragDelta(deltaY) {
    const hasTarget = deltaY < 0 ? Boolean(browserState.nextId) : Boolean(browserState.prevId);
    const damped = hasTarget ? deltaY : deltaY * 0.22;
    activeReelStack()?.style.setProperty("--short-video-mobile-drag-y", `${damped}px`);
  }

  function finishDrag(deltaY, velocityY = 0) {
    const flick = Math.abs(velocityY) >= .42;
    const direction = flick ? (velocityY < 0 ? 1 : -1) : (deltaY < 0 ? 1 : -1);
    browserState.dragging = false;
    activeReelStack()?.classList.remove("is-dragging");
    if ((!flick && Math.abs(deltaY) < 64) || (direction > 0 && !browserState.nextId) || (direction < 0 && !browserState.prevId)) {
      snapStackBack();
      return;
    }
    openAdjacent(direction).catch(() => {});
  }

  function snapStackBack() {
    const stack = activeReelStack();
    if (!stack) return;
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev");
    stack.style.setProperty("--short-video-mobile-drag-y", "0px");
  }

  function animateActiveStack(direction) {
    const stack = activeReelStack();
    if (!stack) return Promise.resolve();
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev");
    stack.style.setProperty("--short-video-mobile-drag-y", "0px");
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      stack.addEventListener("transitionend", finish, { once: true });
      window.setTimeout(finish, 380);
      requestAnimationFrame(() => {
        stack.classList.add(direction > 0 ? "is-snap-next" : "is-snap-prev");
      });
    });
  }

  function handleStageClick(video, panel, singleTapAction) {
    const key = likedVideoKey(video);
    const now = Date.now();
    if (browserState.stageTapTimer && key && browserState.lastStageTapKey === key && now - browserState.lastStageTapAt <= 300) {
      window.clearTimeout(browserState.stageTapTimer);
      browserState.stageTapTimer = null;
      browserState.lastStageTapAt = 0;
      browserState.lastStageTapKey = "";
      likeWebVideo(video, panel);
      return;
    }
    if (browserState.stageTapTimer) window.clearTimeout(browserState.stageTapTimer);
    browserState.lastStageTapAt = now;
    browserState.lastStageTapKey = key;
    browserState.stageTapTimer = window.setTimeout(() => {
      browserState.stageTapTimer = null;
      browserState.lastStageTapAt = 0;
      browserState.lastStageTapKey = "";
      singleTapAction?.();
    }, 260);
  }

  function bindStageLongPress(stage, video) {
    stage.addEventListener("touchstart", (event) => {
      if (event.touches?.length !== 1) return;
      clearStageLongPress();
      const touch = event.touches[0];
      browserState.stageLongPressStartX = touch.clientX;
      browserState.stageLongPressStartY = touch.clientY;
      browserState.stageLongPressTimer = window.setTimeout(() => {
        browserState.stageLongPressTimer = null;
        browserState.stageLongPressTriggered = true;
        try {
          navigator.vibrate?.(12);
        } catch {}
        clearStageTapTimer();
        showPlaybackToolbar(video);
        window.setTimeout(() => {
          browserState.stageLongPressTriggered = false;
        }, 520);
      }, 560);
    }, { passive: true });
    stage.addEventListener("touchmove", (event) => {
      if (!browserState.stageLongPressTimer || event.touches?.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - browserState.stageLongPressStartX;
      const dy = touch.clientY - browserState.stageLongPressStartY;
      if (Math.hypot(dx, dy) > 16) clearStageLongPress();
    }, { passive: true });
    stage.addEventListener("touchend", clearStageLongPress, { passive: true });
    stage.addEventListener("touchcancel", clearStageLongPress, { passive: true });
    stage.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      clearStageTapTimer();
      showPlaybackToolbar(video);
    });
  }

  function clearStageLongPress() {
    if (browserState.stageLongPressTimer) window.clearTimeout(browserState.stageLongPressTimer);
    browserState.stageLongPressTimer = null;
  }

  function consumeStageLongPressClick(event) {
    if (!browserState.stageLongPressTriggered) return false;
    browserState.stageLongPressTriggered = false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function clearStageTapTimer() {
    if (browserState.stageTapTimer) window.clearTimeout(browserState.stageTapTimer);
    browserState.stageTapTimer = null;
    browserState.lastStageTapAt = 0;
    browserState.lastStageTapKey = "";
  }

  function railMetric(icon, value, kind = "", label = "", action = null, active = false) {
    const button = railButton(formatCompact(value || 0), createIcon(icon), kind, label, action);
    button.classList.toggle("active", Boolean(active));
    return button;
  }

  function railNav(direction, action, disabled) {
    const button = railButton("", createIcon(direction === "up" ? "chevronUp" : "chevronDown"), "nav", direction === "up" ? "上一个" : "下一个", action);
    button.disabled = disabled;
    return button;
  }

  function authorRailButton(video, action = null) {
    const avatar = document.createElement("span");
    avatar.className = "short-video-mobile-author-avatar";
    if (video.author?.avatarUrl) {
      const img = document.createElement("img");
      img.src = video.author.avatarUrl;
      img.alt = video.author?.name || "作者";
      avatar.append(img);
    } else {
      avatar.textContent = initials(video.author?.name || "?");
    }
    return railButton("", avatar, "author", video.author?.name ? `作者 ${video.author.name}` : "作者", action);
  }

  function railButton(label, icon, kind = "", ariaLabel = "", action = null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `short-video-mobile-rail-button${kind ? ` is-${kind}` : ""}`;
    if (!label) button.classList.add("is-icon-only");
    button.setAttribute("aria-label", ariaLabel || label || kind || "操作");
    if (ariaLabel) button.title = ariaLabel;
    const strong = document.createElement("strong");
    if (icon instanceof Node) strong.append(icon);
    else strong.textContent = icon;
    button.append(strong);
    if (label) {
      const span = document.createElement("span");
      span.textContent = label;
      button.append(span);
    }
    if (action) button.addEventListener("click", action);
    return button;
  }

  function likedVideoKey(video = {}) {
    const id = String(video.id || "").trim();
    if (id) return id;
    const awemeId = String(video.awemeId || "").trim();
    return awemeId ? `aweme:${awemeId}` : "";
  }

  function isWebLiked(video) {
    const key = likedVideoKey(video);
    return Boolean(key && browserState.likedVideoKeys.has(key));
  }

  function displayWebLikes(video) {
    return Number(video?.stats?.likes || 0) + (isWebLiked(video) ? 1 : 0);
  }

  function likeWebVideo(video, panel = null, button = null) {
    const key = likedVideoKey(video);
    if (!key) {
      shortVideoToast("这条视频暂时不能点赞");
      return;
    }
    if (browserState.likedVideoKeys.has(key)) {
      shortVideoToast("已点过赞");
    } else {
      browserState.likedVideoKeys.add(key);
      shortVideoToast("已点赞");
      showWebLikeBurst(panel);
    }
    updateWebLikeButton(panel, video, button);
  }

  function updateWebLikeButton(panel, video, button = null) {
    const target = button || panel?.querySelector?.(".short-video-mobile-rail-button.is-like");
    if (!target) return;
    target.classList.toggle("active", isWebLiked(video));
    const label = Array.from(target.children || []).find((node) => node.tagName === "SPAN");
    if (label) label.textContent = formatCompact(displayWebLikes(video));
  }

  function showWebLikeBurst(panel) {
    if (!panel) return;
    const existing = panel.querySelector(".short-video-mobile-like-burst");
    if (existing) existing.remove();
    const burst = document.createElement("div");
    burst.className = "short-video-mobile-like-burst";
    burst.textContent = "♥";
    panel.append(burst);
    window.setTimeout(() => burst.remove(), 720);
  }

  return {
    stopPanelMedia,
    activeReelStack,
    isHorizontalSwipe,
    handleHorizontalSwipe,
    isViewingAuthorFeed,
    startSystemInfoUpdates,
    stopSystemInfoUpdates,
    updateSystemInfo,
    readNativeStatusInfo,
    readWebBatteryInfo,
    updateSystemInfoNode,
    formatSystemStatusText,
    formatLocalShortTime,
    applyDragDelta,
    finishDrag,
    snapStackBack,
    animateActiveStack,
    handleStageClick,
    bindStageLongPress,
    clearStageLongPress,
    consumeStageLongPressClick,
    clearStageTapTimer,
    railMetric,
    railNav,
    authorRailButton,
    railButton,
    likedVideoKey,
    isWebLiked,
    displayWebLikes,
    likeWebVideo,
    updateWebLikeButton,
    showWebLikeBurst
  };
}
