import { createIcon, railButton } from "./icons.js?v=20260716-short-video-icons-01";
import { createShortVideoPanelLoadingController } from "./panel-loading-controller.js";
import { createShortVideoInteractionState } from "./interaction-state.js";
import {
  formatCompact,
  formatDuration,
  formatShortVideoMetric
} from "./state.js?v=20260716-short-video-state-01";

export function createShortVideoActionsController(dependencies) {
  const {
    api,
    bindModalFocusLoop,
    cardTitle,
    closeTransientModal,
    focusTransientModal,
    galleryLabel,
    getBrowser,
    getWorkGrid,
    isCurrentVideo,
    isGalleryPost,
    isolateTransientModal,
    interactionState: suppliedInteractionState,
    requestPanel,
    shortVideoAuthorHandle,
    showToast,
    state
  } = dependencies;
  let sharePanelPromise = null;
  const interactionState = suppliedInteractionState || createShortVideoInteractionState();
  const captureShareContext = () => ({
    browser: getBrowser?.(),
    grid: getWorkGrid?.(),
    view: state.activeView,
    id: String(state.shortVideo?.current?.id || ""),
    scope: JSON.stringify([state.shortVideo?.mode, state.shortVideo?.collectionId, state.shortVideo?.source,
      state.shortVideo?.author, state.shortVideo?.query, state.shortVideo?.topic, state.shortVideo?.sound,
      state.shortVideo?.sort, state.shortVideo?.deleted, state.shortVideo?.authorAccountStatus])
  });
  const sharePanelLoading = requestPanel ? null : createShortVideoPanelLoadingController({
    captureContext: captureShareContext,
    isCurrentContext: (owner) => {
      const current = captureShareContext();
      return owner.browser === current.browser && owner.grid === current.grid
        && owner.browser?.isConnected !== false && owner.view === current.view
        && owner.id === current.id && owner.scope === current.scope;
    },
    showError: (error, message) => showToast(error?.message || message)
  });

  function railMetric(icon, value, kind = "", label = "", action = null) {
    const metric = Math.max(0, Number(value || 0));
    const metricLabel = formatCompact(metric);
    const button = railButton(metricLabel, createIcon(icon), kind, label ? `${label}，${metricLabel}` : metricLabel, action);
    button.dataset.actionLabel = label;
    button.dataset.metricValue = String(metric);
    if (label) button.title = label;
    return button;
  }

  function applyRailActionButtonState(button, actionType, active, metricValue) {
    if (!button) return;
    const enabled = Boolean(active);
    const metric = Math.max(0, Number(metricValue || 0));
    const previousMetric = Number(button.dataset.metricValue);
    button.classList.toggle(actionType === "like" ? "is-liked" : "is-active", enabled);
    button.dataset.metricValue = String(metric);
    button.setAttribute("aria-pressed", String(enabled));
    const label = actionType === "like"
      ? (enabled ? "取消点赞" : "点赞")
      : (enabled ? "取消收藏" : "收藏");
    button.dataset.actionLabel = label;
    button.setAttribute("aria-label", `${label}，${formatCompact(metric)}`);
    button.title = label;
    const valueLabel = button.querySelector(":scope > span");
    if (!valueLabel) return;
    valueLabel.textContent = formatCompact(metric);
    if (!Number.isFinite(previousMetric) || previousMetric === metric) return;
    valueLabel.classList.remove("is-metric-up", "is-metric-down");
    valueLabel.getBoundingClientRect();
    valueLabel.classList.add(metric > previousMetric ? "is-metric-up" : "is-metric-down");
    window.clearTimeout(button._railMetricTimer);
    button._railMetricTimer = window.setTimeout(() => {
      valueLabel.classList.remove("is-metric-up", "is-metric-down");
      button._railMetricTimer = 0;
    }, 380);
  }

  async function toggleShortVideoAction(video, actionType, target, options = {}) {
    const type = actionType === "collect" ? "collect" : "like";
    const button = resolveRailActionButton(target, type);
    const videoId = String(video?.id || button?.dataset?.videoId || "").trim();
    if (!button || !videoId) return;
    const field = type === "like" ? "liked" : "collected", metric = type === "like" ? "likes" : "collects";
    const sourceVideo = video?.id ? video : { id: videoId, actions: { [field]: button.classList.contains(type === "like" ? "is-liked" : "is-active") }, stats: { [metric]: Number(button.dataset.metricValue || 0) } };
    const wasActive = interactionState.videoState(sourceVideo, type).active;
    const nextActive = typeof options.forceActive === "boolean" ? options.forceActive : !wasActive;
    if (nextActive === wasActive) return;
    animateRailActionButton(button, nextActive);
    const result = await interactionState.mutateVideo(sourceVideo, type, nextActive, {
      send: active => api(`/api/short-videos/${encodeURIComponent(videoId)}/actions/${type}`, {
        method: "PUT",
        body: { active }
      }),
      onChange: () => {
        syncShortVideoActionVideo(sourceVideo);
        syncShortVideoActionButtons(sourceVideo, type);
        const current = interactionState.videoState(sourceVideo, type);
        applyRailActionButtonState(button, type, current.active, sourceVideo.stats?.[metric]);
        if (current.pending) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
      }
    });
    if (!result.superseded && !options.silent && button.isConnected !== false) {
      showToast(!result.ok ? (type === "like" ? "点赞状态保存失败" : "收藏状态保存失败") : type === "like"
        ? (result.active ? "已点赞" : "已取消点赞") : (result.active ? "已收藏" : "已取消收藏"));
    }
  }

  async function toggleShortVideoDislike(video, active) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return false;
    const desired = typeof active === "boolean" ? active : !interactionState.videoState(video, "dislike").active;
    const result = await interactionState.mutateVideo(video, "dislike", desired, {
      send: desired => api(`/api/short-videos/${encodeURIComponent(videoId)}/actions/dislike`, {
        method: "PUT",
        body: { active: desired }
      }), onChange: () => syncShortVideoActionVideo(video)
    });
    if (!result.superseded) showToast(result.ok ? (result.active ? "已减少此类推荐" : "已撤销不感兴趣") : "推荐反馈保存失败");
    return result.ok && result.active;
  }

  function createAuthorFollowButton(video, author = video?.author || {}, variant = "panel") {
    let boundVideo = video, boundAuthor = author;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `short-video-follow-button is-${variant}`;
    button.dataset.authorFollowVariant = variant;
    const sync = () => {
      interactionState.mergeVideo(boundVideo);
      const current = interactionState.followState(boundVideo, boundAuthor);
      boundAuthor.following = current.active;
      button.dataset.authorFollowKey = current.key;
      button.disabled = !current.key;
      applyAuthorFollowButtonState(button, current.active, boundAuthor?.name || "作者");
      if (current.pending) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
      if (!current.key) button.setAttribute("aria-label", "当前作者无法关注");
    };
    button.shortVideoUpdateMetadata = nextVideo => {
      if (!nextVideo || String(nextVideo.id || "") !== String(boundVideo?.id || "")) return false;
      boundVideo = nextVideo;
      boundAuthor = nextVideo.author || {};
      sync();
      return true;
    };
    button.shortVideoSyncFollow = sync;
    sync();
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      return toggleAuthorFollow(boundVideo, boundAuthor, button).catch(() => {});
    });
    return button;
  }

  function originalDouyinUrl(video) {
    if (isGalleryPost(video)) {
      const galleryUrl = String(video?.originalUrl || video?.shareUrl || "").trim();
      if (galleryUrl) return galleryUrl;
      const galleryId = String(video?.awemeId || video?.id || "").trim();
      return /^\d{8,}$/.test(galleryId) ? `https://www.douyin.com/note/${galleryId}` : "";
    }
    const awemeId = String(video?.awemeId || video?.id || "").trim();
    if (/^\d{8,}$/.test(awemeId)) return `https://www.douyin.com/video/${awemeId}`;
    return String(video?.originalUrl || video?.shareUrl || "").trim();
  }

  function openDouyinLink(video) {
    const url = originalDouyinUrl(video);
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    showToast("当前是本地视频");
  }

  function shareShortVideo(video, options = {}) {
    return (requestPanel || sharePanelLoading.open)({
      load: ensureShortVideoSharePanel,
      show: (showSharePanel, { isCurrent }) => showSharePanel(video, { ...options, isCurrent }),
      trigger: options.trigger,
      errorMessage: "分享模块加载失败"
    });
  }

  async function copyShortVideoValue(value, message = "已复制链接", options = {}) {
    const isCurrent = () => options.isCurrent?.() !== false;
    if (!isCurrent()) return false;
    const text = String(value || "").trim();
    if (!text) throw new Error("没有可复制的内容");
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await Promise.race([
            navigator.clipboard.writeText(text),
            new Promise((_, reject) => window.setTimeout(() => reject(new Error("clipboard timeout")), 800))
          ]);
        } catch {
          if (!isCurrent()) return false;
          fallbackCopyText(text);
        }
      } else {
        fallbackCopyText(text);
      }
      if (!isCurrent()) return false;
      showToast(message);
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      showToast("复制失败，请手动选择链接");
      throw error;
    }
  }

  function localShortVideoUrl(video) {
    const id = String(video?.id || "").trim();
    const url = new URL(window.location.href);
    url.pathname = `/short-videos/${encodeURIComponent(id)}`;
    url.hash = "";
    return url.href;
  }

  function shortVideoShareText(video, url = localShortVideoUrl(video)) {
    const title = cardTitle(video) || "分享一个本地作品";
    const author = String(video?.author?.name || "").trim();
    return [title, author ? shortVideoAuthorHandle(author) : "", url].filter(Boolean).join("\n");
  }

  function resolveRailActionButton(target, actionType) {
    const selector = `.short-video-rail-button.is-${actionType === "like" ? "like" : "collect"}`;
    return target?.matches?.(selector) ? target : target?.querySelector?.(selector) || null;
  }

  function animateRailActionButton(button, active) {
    if (!button || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    button.classList.remove("is-action-pulse", "is-action-release");
    button.getBoundingClientRect();
    const className = active ? "is-action-pulse" : "is-action-release";
    button.classList.add(className);
    window.setTimeout(() => button.classList.remove(className), 460);
  }

  function syncShortVideoActionVideo(updated) {
    if (!updated?.id) return;
    interactionState.mergeVideo(updated);
    for (const item of shortVideoCandidates()) {
      if (!item || String(updated.id) !== String(item.id)) continue;
      interactionState.mergeVideo(item);
    }
  }

  function syncShortVideoActionButtons(video, actionType) {
    interactionState.mergeVideo(video);
    const type = actionType === "collect" ? "collect" : "like";
    const active = type === "like" ? Boolean(video.actions?.liked) : Boolean(video.actions?.collected);
    const metric = type === "like" ? video.stats?.likes : video.stats?.collects;
    const buttons = getWorkGrid()?.querySelectorAll?.(`.short-video-rail-button.is-${type === "like" ? "like" : "collect"}`) || [];
    for (const button of buttons) {
      if (String(button.dataset.videoId || "") !== String(video.id || "")) continue;
      applyRailActionButtonState(button, type, active, metric);
      if (interactionState.videoState(video, type).pending) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
    }
  }

  function authorFollowTargetId(video = {}, author = video?.author || {}) {
    return String(author?.id || video?.ownerUserId || "").trim();
  }

  function authorFollowKey(video = {}, author = video?.author || {}) {
    return authorFollowTargetId(video, author) || String(author?.secUid || "").trim();
  }

  function sameShortVideoAuthor(leftVideo = {}, rightVideo = {}) {
    const leftTarget = authorFollowTargetId(leftVideo, leftVideo?.author);
    const rightTarget = authorFollowTargetId(rightVideo, rightVideo?.author);
    if (leftTarget && rightTarget) return leftTarget === rightTarget;
    const leftSecUid = String(leftVideo?.author?.secUid || "").trim();
    const rightSecUid = String(rightVideo?.author?.secUid || "").trim();
    return Boolean(leftSecUid && rightSecUid && leftSecUid === rightSecUid);
  }

  function applyAuthorFollowButtonState(button, following, authorName = "作者") {
    if (!button) return;
    const active = Boolean(following);
    const variant = button.dataset.authorFollowVariant || "panel";
    button.classList.toggle("is-following", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", `${active ? "取消关注" : "关注"} ${authorName}`);
    button.title = active ? `取消关注 ${authorName}` : `关注 ${authorName}`;
    if (variant === "rail") {
      button.replaceChildren(createIcon(active ? "check" : "plusBadge"));
      return;
    }
    button.textContent = active ? "已关注" : variant === "page" ? "已取关" : "+ 关注";
  }

  async function toggleAuthorFollow(video, author = video?.author || {}, button) {
    const authorId = authorFollowKey(video, author);
    if (!authorId || !button) return;
    const nextFollowing = !interactionState.followState(video, author).active;
    const result = await interactionState.mutateFollow(video, author, nextFollowing, {
      send: active => api(`/api/short-videos/authors/${encodeURIComponent(authorId)}/follow`, {
        method: "PUT",
        body: { active }
      }), onChange: () => syncShortVideoAuthorFollow(video)
    });
    if (!result.superseded && button.isConnected !== false && button.dataset.authorFollowKey === result.key) {
      showToast(result.ok ? (result.active ? `已关注 ${author?.name || "作者"}` : `已取关 ${author?.name || "作者"}`) : "关注状态保存失败");
    }
  }

  function syncShortVideoAuthorFollow(updatedVideo, following) {
    if (!updatedVideo) return;
    interactionState.mergeVideo(updatedVideo);
    for (const item of shortVideoCandidates()) {
      if (item) interactionState.mergeVideo(item);
    }
    for (const item of state.shortVideo?.authors || []) {
      item.following = interactionState.mergeVideo({ author: item }).author.following;
    }
    if (state.shortVideo?.authorDetail) {
      const item = state.shortVideo.authorDetail;
      item.following = interactionState.mergeVideo({ author: item }).author.following;
    }
    const buttons = getWorkGrid()?.querySelectorAll?.("[data-author-follow-key]") || [];
    for (const followButton of buttons) {
      followButton.shortVideoSyncFollow?.();
    }
  }

  function shortVideoCandidates() {
    return [
      state.shortVideo?.current,
      state.shortVideo?.prevVideo,
      state.shortVideo?.nextVideo,
      ...(state.shortVideo?.data?.videos || []),
      ...(state.shortVideo?.collectionData?.videos || [])
    ];
  }

  function ensureShortVideoSharePanel() {
    if (sharePanelPromise) return sharePanelPromise;
    const moduleUrl = "/modules/short-videos/share-panel.js?v=20261027-share-lifecycle-01";
    sharePanelPromise = import(moduleUrl).then((module) => {
      if (typeof module.createShortVideoSharePanel !== "function") throw new Error("分享模块加载失败");
      return module.createShortVideoSharePanel({
        bindShortVideoModalFocusLoop: bindModalFocusLoop,
        cardTitle,
        closePlaybackSettings: closeTransientModal,
        copyShortVideoValue,
        createIcon,
        focusShortVideoTransientModal: focusTransientModal,
        formatDuration,
        formatShortVideoMetric,
        galleryLabel,
        getBrowser,
        isGalleryPost,
        isolateShortVideoTransientModal: isolateTransientModal,
        localShortVideoUrl,
        originalDouyinUrl,
        shortVideoAuthorHandle,
        shortVideoShareText,
        showBrowserToast: showToast,
        state
      });
    }).catch((error) => {
      sharePanelPromise = null;
      throw error;
    });
    return sharePanelPromise;
  }

  function fallbackCopyText(value) {
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.append(input);
    input.select();
    const copied = document.execCommand?.("copy");
    input.remove();
    if (!copied) throw new Error("copy failed");
  }

  return Object.freeze({
    applyRailActionButtonState,
    copyShortVideoValue,
    createAuthorFollowButton,
    localShortVideoUrl,
    openDouyinLink,
    originalDouyinUrl,
    railMetric,
    shareShortVideo,
    shortVideoShareText,
    toggleShortVideoAction,
    toggleShortVideoDislike
  });
}
