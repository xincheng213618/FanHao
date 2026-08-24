import { createShortVideoSearchModule } from "./search/index.js?v=20260710-short-video-search-01";
import { createShortVideoActionsController } from "./actions-controller.js?v=20260716-short-video-actions-01";
import { createShortVideoAuthorPages } from "./author-pages.js?v=20260825-profile-history-01";
import { createShortVideoCollectionsController } from "./collections-controller.js?v=20260812-collection-busy-01";
import { captionTitleWithTags, createShortVideoCaptionText } from "./caption-text.js?v=20260811-custom-collections-01";
import { createShortVideoFilterControls } from "./filter-controls.js?v=20260810-author-account-status-01";
import { createIcon, railButton, setIconButton } from "./icons.js?v=20260824-local-file-actions-01";
import { createShortVideoLocalActions } from "./local-actions.js?v=20260824-local-file-actions-01";
import { createShortVideoListWindow } from "./list-window.js?v=20260716-short-video-list-window-01";
import { createShortVideoMediaCache } from "./media-cache.js?v=20260716-short-video-media-cache-01";
import { readLikeDistributionCache } from "./like-distribution-cache.js?v=20260825-author-efficiency-01";
import { createLikeDistributionLoader } from "./like-distribution-loader.js?v=20260825-author-cleanup-02";
import { renderLikeDistributionPageShell } from "./like-distribution-page-shell.js?v=20260825-author-efficiency-01";
import { createShortVideoPlaybackRenditionPolicy } from "./playback-rendition-policy.js?v=20260720-observed-playback-issues-01";
import { createShortVideoPlayerSourceLifecycle, disposeShortVideoMedia } from "./player-source-lifecycle.js?v=20260811-custom-collections-01";
import { createShortVideoTranscodeManagementPage } from "./transcode-management-page.js?v=20260720-transcode-continuous-08";
import { createShortVideoTranscodeStatusButton } from "./transcode-status-button.js?v=20260720-transcode-popup-09";
import { mergeShortVideoWatchPayload } from "./watch-write-payload.js?v=20260813-watch-write-pending-01";
import { shortVideoDeleteCompletedMessage, shortVideoDeletePendingMessage } from "./delete-contract.js?v=20260813-delete-recovery-01";
import { createShortVideoDeleteActions } from "./delete-actions.js?v=20260823-delete-confirm-01";
import { createShortVideoDeleteRecoveryController } from "./delete-recovery.js?v=20260813-delete-client-state-02";
import {
  applyShortVideoLikeBadgeState,
  clampNumber,
  ensureShortVideoState,
  formatCompact,
  formatDate,
  formatDuration,
  formatLocalCommentDate,
  formatPlaybackRate,
  formatSeconds,
  formatShortVideoMetric,
  initials,
  normalizePlaybackRate,
  normalizeShortVideoAuthorAccountStatus,
  normalizeShortVideoAuthorFilter,
  normalizeShortVideoAuthorSort,
  normalizeShortVideoDeleted,
  normalizeShortVideoMedia,
  normalizeShortVideoQuality,
  normalizeShortVideoSortValue,
  normalizeShortVideoSound,
  normalizeShortVideoSource,
  normalizeShortVideoTopic,
  normalizeShortVideoVolume,
  readAutoNextPreference,
  readMutedPreference,
  readPlaybackRatePreference,
  readSmartFillPreference,
  readVolumePreference,
  shortVideoQualityLabel,
  writeAutoNextPreference,
  writeMutedPreference,
  writePlaybackRatePreference,
  writeSmartFillPreference,
  writeVolumePreference
} from "./state.js?v=20260716-short-video-state-01";
import { discardAuthorIndexWindowAfterRouteChange, isCurrentShortVideoLoadRequest, restoreSavedAuthorIndexWindow, settleShortVideoLoad, SHORT_VIDEO_LOAD_STALE } from "./author-navigation.js?v=20260811-author-load-contract-01";

export function createShortVideoPage(deps) {
  const {
    api,
    cancelScheduledWorkRendering,
    disconnectPeopleIndexAutoload,
    els,
    ensureShortVideoViewerStyles,
    formatBytes,
    formatNumber,
    hidePersonProfile,
    pushRoute,
    replaceRoute,
    resetProgressiveCoverLoading,
    setMainHeader,
    state,
    syncRouteAfterNavigation,
    takeDirectShortVideoPlaybackPrewarm
  } = deps;
  let likeDistributionViewPromise = null;
  let likeDistributionRenderToken = 0;
  let shortVideoCommentsViewPromise = null;
  let shortVideoPlaybackSettingsPromise = null;
  let shortVideoPlaybackSettingsWarmupScheduled = false;
  let shortVideoAuthorPanelPromise = null;
  let shortVideoGalleryPlayerPromise = null;
  let shortVideoListCardsPromise = null;
  let shortVideoListCards = null;
  const playbackRenditionPolicy = createShortVideoPlaybackRenditionPolicy({ api });
  const deleteRecoveryController = createShortVideoDeleteRecoveryController({ api });
  const deleteActions = createShortVideoDeleteActions({ api, recovery: deleteRecoveryController, showToast: showBrowserToast });
  const runShortVideoLocalAction = createShortVideoLocalActions({ api, showToast: showBrowserToast });
  const { loadLikeDistribution } = createLikeDistributionLoader({ api, render: renderView, shortVideoState: state.shortVideo });
  const transcodeManagementPage = createShortVideoTranscodeManagementPage({ api, els, formatBytes, setMainHeader, state });
  const {
    ensureShortVideoPlayerSource,
    warmAdjacentVideoPlayer
  } = createShortVideoPlayerSourceLifecycle({
    markPerformance: markShortVideoPerformance,
    playbackUrl: shortVideoPlaybackUrl,
    waitForFirstFrame: waitForVideoFirstFrame
  });
  let wheelLocked = false;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchDeltaX = 0;
  let touchDeltaY = 0;
  let touchHorizontalDragging = false;
  let touchLastX = 0;
  let touchLastY = 0;
  let touchLastAt = 0;
  let touchVelocityX = 0;
  let touchVelocityY = 0;
  let touchControlInteraction = false;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let pointerDeltaX = 0;
  let pointerDeltaY = 0;
  let pointerHorizontalDragging = false;
  let pointerDragging = false;
  let pointerLastX = 0;
  let pointerLastY = 0;
  let pointerLastAt = 0;
  let pointerVelocityX = 0;
  let pointerVelocityY = 0;
  let suppressNextPlayerClick = false;
  let holdSpeedGestureConsumed = false;
  let holdSpeedGestureBlockUntil = 0;
  let wheelDeltaY = 0;
  let wheelLastAt = 0;
  let wheelResetTimer = 0;
  let reelDragRaf = 0;
  let reelDragDeltaY = 0;
  let reelBoundaryPulseRaf = 0;
  let reelBoundaryPulseTimer = 0;
  let reelBoundaryResetTimer = 0;
  let wheelIgnoreUntil = 0;
  let wheelGestureConsumed = false;
  let wheelGestureStartedAt = 0;
  let queuedAdjacentDirection = 0;
  let eventsInstalled = false;
  let playerClickTimer = 0;
  let pendingPlayerTap = null;
  const initialVideoLimit = 48;
  const appendVideoLimit = 72;
  const coverEagerCount = 18;
  const AUTHOR_PAGE_SIZE = 96;
  const AUTHOR_APPEND_LOOKAHEAD = 900;
  const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  let authorPanelReturnFeed = null;
  let authorPanelVideoRequestId = 0;
  let authorPanelVideoCache = null;
  let authorPanelTileMap = null;
  let shortVideoAdjacentRequestId = 0;
  let shortVideoListRequestId = 0;
  let shortVideoOpenRequestId = 0;
  let shortVideoOpeningId = "";
  let shortVideoOpenError = "";
  let shortVideoNavigationPrefetchTimer = 0;
  let shortVideoVisibilitySnapshot = null;
  let shortVideoAdjacentWarmDirection = 1;
  let shortVideoAdjacentWarmScheduleId = 0;
  let shortVideoLastNavigationAt = 0;
  let shortVideoCacheSampleCounter = 0;
  const loadedCoverIds = new Set();
  const shortVideoWatchWrites = new Map();
  const shortVideoAuthorMentionCache = new Map();
  const shortVideoVideoPrefetches = new Map();
  const SHORT_VIDEO_WATCH_SAVE_INTERVAL = 4000;
  const SHORT_VIDEO_GALLERY_ADVANCE_MS = 3000;
  const SHORT_VIDEO_GALLERY_GESTURE_HINT_MS = 3200;
  const SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY = "fanhao.shortVideo.galleryGestureHintSeen";
  const SHORT_VIDEO_SMART_FILL_KEY = "fanhao.shortVideo.smartFill";
  const SHORT_VIDEO_LOADED_COVER_CACHE_LIMIT = 512;
  const SHORT_VIDEO_WATCH_WRITE_CACHE_LIMIT = 128;
  const SHORT_VIDEO_AUTHOR_MENTION_CACHE_LIMIT = 256;
  // The reel only keeps one previous and one next panel alive. Fetching a
  // second ring here inflated every detail payload by roughly 40%; the next
  // ring is already filled by the deferred adjacent-detail prefetch.
  const SHORT_VIDEO_SWIPE_DISTANCE = 44;
  const SHORT_VIDEO_WHEEL_DISTANCE = 82;
  const SHORT_VIDEO_SWITCH_ANIMATION_MS = 220;
  const SHORT_VIDEO_PREWARMED_SWITCH_ANIMATION_MS = 72;
  const SHORT_VIDEO_SWITCH_MIN_ANIMATION_MS = 112;
  const SHORT_VIDEO_SWITCH_MAX_ANIMATION_MS = 232;
  // A cold decoder can legitimately need longer than the reel animation,
  // especially after several rapid 2K/4K switches. Wait briefly for a painted
  // frame, but still advance after the timeout so one broken media item cannot
  // permanently block navigation to every later reel.
  const SHORT_VIDEO_SWITCH_PRIME_TIMEOUT_MS = 1200;
  // Let the visible stream settle before asking the browser to decode a second
  // 2K frame. Starting the adjacent decoder immediately after first paint
  // caused a noticeable opening hitch on machines with one hardware decoder.
  const SHORT_VIDEO_ADJACENT_WARM_STABLE_MS = 650;
  const SHORT_VIDEO_ADJACENT_WARM_RAPID_MS = 80;
  const SHORT_VIDEO_RAPID_NAV_WARM_WINDOW_MS = 1200;
  // The current detail response already carries the immediately visible
  // neighbors. Fetching the next navigation ring before the current player has
  // painted can contend with a cold media pipeline, so only fill that second
  // ring after the visible frame has had a short stable window.
  const SHORT_VIDEO_NAV_PREFETCH_AFTER_FRAME_MS = 320;
  const SHORT_VIDEO_NAV_PREFETCH_MAX_WAIT_MS = 3600;
  const SHORT_VIDEO_FIRST_FRAME_TIMEOUT_MS = 1600;
  const SHORT_VIDEO_FIRST_FRAME_RETRY_LIMIT = 4;
  const SHORT_VIDEO_BOUNDARY_RESISTANCE = 0.3;
  const SHORT_VIDEO_BOUNDARY_RANGE = 180;
  const SHORT_VIDEO_HOLD_ARM_MOVE_TOLERANCE = 12;
  const SHORT_VIDEO_HOLD_ACTIVE_MOVE_TOLERANCE = 26;
  const SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS = 520;
  const WHEEL_GESTURE_IDLE_MS = 220;
  const WHEEL_NEW_GESTURE_GAP_MS = 160;
  const {
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
  } = createShortVideoActionsController({
    api,
    bindModalFocusLoop: bindShortVideoModalFocusLoop,
    cardTitle,
    closeTransientModal: closePlaybackSettings,
    focusTransientModal: focusShortVideoTransientModal,
    galleryLabel,
    getBrowser: () => els.workGrid?.querySelector?.(".short-video-browser"),
    getWorkGrid: () => els.workGrid,
    isCurrentVideo: isCurrentShortVideo,
    isGalleryPost,
    isolateTransientModal: isolateShortVideoTransientModal,
    shortVideoAuthorHandle: (author) => shortVideoAuthorHandle(author),
    showToast: showBrowserToast,
    state
  });
  const collectionsController = createShortVideoCollectionsController({
    api,
    createIcon,
    ensureListCards: ensureShortVideoListCards,
    getListCards: () => shortVideoListCards,
    loadFeed: () => loadVideos({ skipRoute: true }).catch(showError),
    onNavigationChange: () => { syncCurrentNavigationDom(); syncActivePlaybackMode(); },
    onOpenVideo: (video, options = {}) => openVideo(video.id, {
      ...options,
      ...(Object.keys(video || {}).length > 1 ? { video } : {})
    }).catch(showError),
    pushRoute,
    replaceRoute,
    render: renderView,
    setMainHeader,
    showToast: showBrowserToast,
    state
  });
  const appendCaptionText = createShortVideoCaptionText({
    normalizeTopic: normalizeShortVideoTopic,
    openTopic: (video, topic) => showAuthorPanel(video, { initialTab: "topic", topic, switchAuthorFeed: false }).catch(showError)
  });
  const shortVideoSearch = createShortVideoSearchModule({
    api,
    createIcon,
    getState: () => state.shortVideo,
    onSearch: commitShortVideoSearch
  });
  const {
    appendVisibleAuthorsIfNeeded,
    authorNameFromFilter,
    cancelAuthorCollectorPolling,
    currentShortVideoAuthorDetail,
    isShortVideoAuthorDetailPage,
    isShortVideoAuthorIndexPage,
    openShortVideoAuthorPage,
    renderAuthorDetailHome,
    renderAuthorIndex,
    renderAuthorIndexCard,
    renderAuthorSignature,
    renderAuthorWorkspaceToolbar,
    renderSearchUserCard,
    resolveShortVideoAuthor,
    shortVideoApiSource,
    shortVideoAuthorFilterValue,
    shortVideoAuthorHandle,
    syncAuthorCollectorRouteLifecycle
  } = createShortVideoAuthorPages({
    AUTHOR_APPEND_LOOKAHEAD,
    api,
    authorAvatar,
    authorProfileLineText,
    authorScopeId,
    cacheShortVideoAuthorMention,
    clearShortVideoDeleteSelection,
    createAuthorFollowButton,
    createIcon,
    formatCompact,
    formatDate,
    formatNumber,
    getShortVideoListCards: () => shortVideoListCards,
    loadVideos,
    openAuthorDouyinLink, runShortVideoLocalAction,
    profileNumber,
    pushRoute,
    renderDeleteSelectionActions,
    replaceRoute,
    setAuthorPanelReturnFeed: (value) => {
      authorPanelReturnFeed = value;
    },
    shortVideoAuthorMentionCache,
    shortVideoCardCoverUrl,
    shortVideoSearch,
    showBrowserToast,
    showError,
    state
  });
  const {
    renderAuthorAccountStatusControl,
    renderDeletedControl: renderShortVideoDeletedControl,
    renderSortControl: renderShortVideoSortControl
  } = createShortVideoFilterControls({
    clearSelection: clearShortVideoDeleteSelection,
    formatNumber,
    isAuthorDetailPage: isShortVideoAuthorDetailPage,
    loadVideos,
    normalizeAuthorAccountStatus: normalizeShortVideoAuthorAccountStatus,
    normalizeDeleted: normalizeShortVideoDeleted,
    normalizeSort: normalizeShortVideoSortValue,
    showError,
    state
  });
  const {
    activateCovers: activateShortVideoCovers,
    attach: attachShortVideoWindow,
    render: renderShortVideoWindow,
    reset: resetShortVideoWindow,
    resize: resizeShortVideoWindow,
    scheduleAppendContinuation: scheduleShortVideoAppendContinuation,
    scheduleUpdate: scheduleShortVideoWindowUpdate
  } = createShortVideoListWindow({
    getState: () => state,
    isAuthorDetailPage: isShortVideoAuthorDetailPage,
    loadVideos,
    markCacheState: markShortVideoCacheState,
    markPerformance: markShortVideoPerformance,
    rememberLoadedCoverId,
    renderVideoCard: (video, index) => shortVideoListCards?.renderVideoCard(video, index) || null,
    shortVideoCardCoverUrl,
    shortVideosWithCovers,
    showError,
    wasCoverLoaded: (videoId) => loadedCoverIds.has(videoId)
  });
  const {
    cachedNavigation: cachedShortVideoNavigation,
    cachedVideo: cachedShortVideo,
    fetchDetail: fetchShortVideoDetail,
    prefetchFirstMedia: prefetchShortVideoFirstMedia,
    prefetchRelatedVideo,
    prewarmPlayback: prewarmShortVideoPlayback,
    rememberVideo: rememberShortVideo,
    resolvedDetail: resolvedShortVideoDetail,
    stats: shortVideoMediaCacheStats,
    takePrewarmedPlayer: takePrewarmedShortVideoPlayer
  } = createShortVideoMediaCache({
    api,
    cacheAuthorPanelVideo,
    cachedAuthorPanelVideo,
    galleryImageEntries,
    getFeedParams: shortVideoFeedParams,
    isGalleryPost,
    markPerformance: markShortVideoPerformance,
    shortVideoCardCoverUrl,
    shortVideoPlaybackUrl,
    takeDirectPlaybackPrewarm: takeDirectShortVideoPlaybackPrewarm,
    waitForVideoFirstFrame
  });

  function contextualShortVideoDetail(videoId) {
    return state.shortVideo.mode === "collection"
      ? collectionsController.loadCollectionVideoDetail(videoId)
      : fetchShortVideoDetail(videoId);
  }
  function markShortVideoPerformance(name, details = {}) {
    const now = Date.now();
    const trace = window.__fanhaoShortVideoPerf && typeof window.__fanhaoShortVideoPerf === "object"
      ? window.__fanhaoShortVideoPerf
      : {
          version: 1,
          startedAt: Math.floor(Number(globalThis.performance?.timeOrigin || now)),
          events: []
        };
    const event = {
      name: String(name || "event"),
      at: now,
      elapsedMs: Math.max(0, now - Number(trace.startedAt || now)),
      ...details
    };
    trace.events = Array.isArray(trace.events) ? trace.events : [];
    trace.events.push(event);
    if (trace.events.length > 240) trace.events.splice(0, trace.events.length - 240);
    trace.latest = event;
    window.__fanhaoShortVideoPerf = trace;
    if (document.documentElement.dataset.shortVideoPerfCapture === "1") {
      document.documentElement.dataset.shortVideoPerfTrace = JSON.stringify({
        version: trace.version,
        startedAt: trace.startedAt,
        latest: trace.latest,
        events: trace.events.slice(-120)
      });
    }
    return event;
  }

  function rememberLoadedCoverId(videoId) {
    const id = String(videoId || "").trim();
    if (!id) return;
    loadedCoverIds.delete(id);
    loadedCoverIds.add(id);
    while (loadedCoverIds.size > SHORT_VIDEO_LOADED_COVER_CACHE_LIMIT) {
      loadedCoverIds.delete(loadedCoverIds.values().next().value);
    }
  }

  function cacheShortVideoAuthorMention(key, author) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey || !author) return;
    shortVideoAuthorMentionCache.delete(normalizedKey);
    shortVideoAuthorMentionCache.set(normalizedKey, author);
    while (shortVideoAuthorMentionCache.size > SHORT_VIDEO_AUTHOR_MENTION_CACHE_LIMIT) {
      shortVideoAuthorMentionCache.delete(shortVideoAuthorMentionCache.keys().next().value);
    }
  }

  function trimShortVideoWatchWrites(protectedVideoId = "") {
    while (shortVideoWatchWrites.size > SHORT_VIDEO_WATCH_WRITE_CACHE_LIMIT) {
      const removable = [...shortVideoWatchWrites.entries()]
        .find(([videoId, write]) => videoId !== protectedVideoId && !write?.inFlight && !write?.pending);
      if (!removable) return;
      shortVideoWatchWrites.delete(removable[0]);
    }
  }

  function markShortVideoCacheState() {
    if (document.documentElement.dataset.shortVideoPerfCapture !== "1") return;
    shortVideoCacheSampleCounter += 1;
    if (shortVideoCacheSampleCounter % 16 !== 0) return;
    markShortVideoPerformance("short-video-cache-state", {
      loadedCovers: loadedCoverIds.size,
      watchWrites: shortVideoWatchWrites.size,
      authorMentions: shortVideoAuthorMentionCache.size,
      ...shortVideoMediaCacheStats()
    });
  }

  function shortVideoPlaybackUrl(video = {}) { return playbackRenditionPolicy.playbackUrl(video); }

  function ensureState() {
    return ensureShortVideoState(state, {
      installBrowseEvents,
      smartFillKey: SHORT_VIDEO_SMART_FILL_KEY
    });
  }
  function enter(options = {}) {
    ensureState();
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    hidePersonProfile();
    disconnectPeopleIndexAutoload();
    cancelScheduledWorkRendering();
    resetProgressiveCoverLoading();
    setMainHeader("短视频", "抖音点赞本地库");
    setBodyClass();
    renderStats();
    if (options.deferInitialLoad) {
      renderView();
      return;
    }
    if (!state.shortVideo.data || options.reload) {
      loadVideos({ skipRoute: true }).catch(showError);
    } else {
      renderView();
      loadShortVideoSummary().catch(handleSummaryLoadError);
    }
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route = {}) {
    ensureState();
    const previousAuthorPage = state.shortVideo.authorPage;
    syncAuthorCollectorRouteLifecycle(route.shortVideoMode !== "likes" && !route.shortVideoId ? route.shortVideoAuthorPage : "");
    state.shortVideo.mode = ["collection", "likes", "transcoding"].includes(route.shortVideoMode) ? route.shortVideoMode : "feed";
    state.shortVideo.collectionId = state.shortVideo.mode === "collection" ? String(route.shortVideoCollectionId || "") : "";
    const nextAuthorPage = route.shortVideoAuthorPage || "";
    if (state.shortVideo.authorPage && state.shortVideo.authorPage !== nextAuthorPage) {
      state.shortVideo.authorDetail = null;
      state.shortVideo.authorVideo = null;
    }
    state.shortVideo.query = route.shortVideoQuery || "";
    state.shortVideo.topic = normalizeShortVideoTopic(route.shortVideoTopic);
    state.shortVideo.sound = normalizeShortVideoSound(route.shortVideoSound);
    if (!state.shortVideo.sound) state.shortVideo.soundInfo = null;
    state.shortVideo.authorPage = nextAuthorPage;
    state.shortVideo.author = state.shortVideo.authorPage || route.shortVideoAuthor || "all";
    state.shortVideo.media = normalizeShortVideoMedia(route.shortVideoMedia);
    state.shortVideo.quality = normalizeShortVideoQuality(route.shortVideoQuality);
    state.shortVideo.deleted = normalizeShortVideoDeleted(route.shortVideoDeleted);
    state.shortVideo.authorAccountStatus = normalizeShortVideoAuthorAccountStatus(route.shortVideoAuthorAccountStatus);
    if (state.shortVideo.quality !== "all") state.shortVideo.media = "video";
    state.shortVideo.source = normalizeShortVideoSource(route.shortVideoSource);
    if (!state.shortVideo.authorPage && ["authors", "following"].includes(state.shortVideo.source)) state.shortVideo.authorIndexSource = state.shortVideo.source;
    state.shortVideo.sort = normalizeShortVideoSortValue(route.shortVideoSort);
    if (state.shortVideo.source === "recommended" && state.shortVideo.sort === "published") {
      state.shortVideo.sort = "recommended";
    } else if (state.shortVideo.source === "history" && state.shortVideo.sort === "published") {
      state.shortVideo.sort = "watched";
    }
    discardAuthorIndexWindowAfterRouteChange(state.shortVideo, previousAuthorPage);
  }

  async function openRouteTarget(route = {}) {
    ensureState();
    if (route.shortVideoMode === "collection") {
      await collectionsController.openCollection(route.shortVideoCollectionId, { skipRoute: true, videoId: route.shortVideoId });
      return;
    }
    if (route.shortVideoMode === "transcoding") {
      transcodeManagementPage.activate();
      renderView();
      return;
    }
    if (route.shortVideoMode === "likes") {
      state.shortVideo.current = null;
      state.shortVideo.prevVideo = null;
      state.shortVideo.nextVideo = null;
      state.shortVideo.prevId = "";
      state.shortVideo.nextId = "";
      const authorEfficiencyTable = isLikeDistributionAuthorTableRoute();
      setMainHeader(authorEfficiencyTable ? "作者占用与命中" : "内容洞察", "短视频 / 数据统计");
      const cached = readLikeDistributionCache(state.shortVideo.likeDistribution);
      if (cached.data) state.shortVideo.likeDistribution = cached.data;
      renderView();
      // The statistics request can take a while on a cold cache. Reveal the
      // rendered loading shell before awaiting it so direct visits never sit
      // on the entry document's blank module-loading state.
      document.documentElement.classList.remove("app-module-loading");
      if (!state.shortVideo.likeDistribution) await loadLikeDistribution();
      else if (!cached.fresh) loadLikeDistribution({ silent: true }).catch(() => {});
      return;
    }
    if (!route.shortVideoId && collectionsController.restoreFeedAfterRoute(route)) return;
    if (route.shortVideoId) {
      await openVideo(route.shortVideoId, { skipRoute: true });
      return;
    }
    shortVideoOpenRequestId += 1;
    shortVideoOpeningId = "";
    shortVideoOpenError = "";
    if (route.shortVideoAuthorPage) {
      state.shortVideo.authorPage = route.shortVideoAuthorPage;
      state.shortVideo.author = route.shortVideoAuthorPage;
    }
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    await loadVideos({ skipRoute: true });
  }

  async function loadVideos(options = {}) {
    ensureState();
    syncAuthorCollectorRouteLifecycle(state.shortVideo.current ? "" : state.shortVideo.authorPage);
    const append = Boolean(options.append);
    const preserveHomeDuringLoad = preserveShortVideoHomeDuringLoad(append);
    if (!append && !shortVideoListCards) {
      ensureShortVideoListCards().catch((error) => console.warn(error));
    }
    if (isShortVideoAuthorIndexPage()) {
      if (append && (state.shortVideo.loading || state.shortVideo.authorLoadingMore || !state.shortVideo.authorHasMore)) return;
      if (restoreSavedAuthorIndexWindow(state.shortVideo, append, () => { renderStats(); renderView(); }, () => { shortVideoListRequestId += 1; shortVideoOpenRequestId += 1; })) return;
      const requestId = ++shortVideoListRequestId;
      state.shortVideo.current = null;
      state.shortVideo.prevVideo = null;
      state.shortVideo.nextVideo = null;
      state.shortVideo.prevId = "";
      state.shortVideo.nextId = "";
      if (!preserveHomeDuringLoad) state.shortVideo.data = null;
      if (append) {
        state.shortVideo.authorLoadingMore = true;
      } else {
        state.shortVideo.loading = true;
        state.shortVideo.authorLoadingMore = false;
        if (!preserveHomeDuringLoad) {
          state.shortVideo.authors = [];
          state.shortVideo.authorTotal = 0;
          state.shortVideo.authorScopeTotal = 0;
          state.shortVideo.authorUnlikedTotal = 0;
          state.shortVideo.authorBannedTotal = 0;
          state.shortVideo.authorHasMore = false;
        }
      }
      state.shortVideo.status = append ? "" : "正在读取作者";
      if (!preserveHomeDuringLoad) renderView();
      const params = new URLSearchParams({
        limit: String(AUTHOR_PAGE_SIZE),
        offset: String(append ? state.shortVideo.authors.length : 0)
      });
      if (state.shortVideo.source === "following") {
        params.set("scope", "following");
        params.set("sort", state.shortVideo.authorSort);
        params.set("filter", state.shortVideo.authorFilter);
      } else {
        params.set("filter", state.shortVideo.authorAccountStatus);
      }
      if (state.shortVideo.query) params.set("q", state.shortVideo.query);
      const data = await api(`/api/short-videos/authors?${params}`);
      if (requestId !== shortVideoListRequestId) return;
      const nextAuthors = Array.isArray(data.authors) ? data.authors : [];
      if (append) {
        const merged = [...state.shortVideo.authors];
        const seen = new Set(merged.map((author) => shortVideoAuthorFilterValue(author)).filter(Boolean));
        for (const author of nextAuthors) {
          const key = shortVideoAuthorFilterValue(author);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          merged.push(author);
        }
        state.shortVideo.authors = merged;
      } else {
        state.shortVideo.authors = nextAuthors;
      }
      state.shortVideo.authorTotal = Math.max(0, Number(data.total || 0));
      state.shortVideo.authorScopeTotal = Math.max(0, Number(data.scopeTotal || data.total || 0));
      state.shortVideo.authorUnlikedTotal = Math.max(0, Number(data.unlikedTotal || 0));
      state.shortVideo.authorBannedTotal = Math.max(0, Number(data.bannedTotal || 0));
      state.shortVideo.authorHasMore = Boolean(data.hasMore);
      state.shortVideo.loading = false;
      state.shortVideo.authorLoadingMore = false;
      state.shortVideo.status = "";
      renderStats();
      renderView();
      loadShortVideoSummary().catch(handleSummaryLoadError);
      if (!options.skipRoute) {
        const writer = options.replaceRoute ? replaceRoute : pushRoute;
        writer({ view: "shortVideos", shortVideoId: "" });
      }
      return;
    }
    if (append && (state.shortVideo.loading || state.shortVideo.loadingMore || !state.shortVideo.data?.hasMore)) return;
    const requestId = ++shortVideoListRequestId;
    const captureListPerformance = document.documentElement.dataset.shortVideoPerfCapture === "1";
    const listRequestStartedAt = Date.now();
    if (captureListPerformance) {
      markShortVideoPerformance("short-video-list-request-start", {
        append,
        requestId,
        offset: append ? Number(state.shortVideo.data?.videos?.length || 0) : 0
      });
    }
    if (append) {
      state.shortVideo.loadingMore = true;
    } else {
      state.shortVideo.loading = true;
      state.shortVideo.status = "正在读取短视频";
    }
    if (!options.keepCurrent) {
      state.shortVideo.current = null;
      state.shortVideo.prevVideo = null;
      state.shortVideo.nextVideo = null;
      state.shortVideo.prevId = "";
      state.shortVideo.nextId = "";
    }
    if (!append && !preserveHomeDuringLoad) renderView();
    const params = new URLSearchParams();
    if (state.shortVideo.query) params.set("q", state.shortVideo.query);
    if (state.shortVideo.topic) params.set("topic", state.shortVideo.topic);
    if (state.shortVideo.sound) params.set("sound", state.shortVideo.sound);
    if (state.shortVideo.author && state.shortVideo.author !== "all") params.set("author", state.shortVideo.author);
    if (state.shortVideo.media && state.shortVideo.media !== "all") params.set("media", state.shortVideo.media);
    if (state.shortVideo.quality && state.shortVideo.quality !== "all") params.set("quality", state.shortVideo.quality);
    if (state.shortVideo.deleted === "deleted") params.set("deleted", "1");
    params.set("source", shortVideoApiSource());
    params.set("sort", state.shortVideo.sort || "published");
    params.set("limit", String(append ? appendVideoLimit : initialVideoLimit));
    params.set("facets", "0");
    params.set("stats", "0");
    // Actual-resolution probes can move videos into a quality bucket while the
    // user is scrolling. Likes-ordered feeds therefore continue from the last
    // stable sort key instead of an OFFSET whose membership may have shifted.
    const appendCursor = append && state.shortVideo.sort === "likes"
      ? String(state.shortVideo.data?.nextCursor || "")
      : "";
    if (appendCursor) params.set("cursor", appendCursor);
    else if (append) params.set("offset", String(state.shortVideo.data?.videos?.length || 0));
    if (append) params.set("users", "0");
    // Quality-filtered pages are cheap indexed reads and must not mix a cached
    // pre-probe page with newly measured append pages.
    if (state.shortVideo.quality !== "all") params.set("refresh", "1");
    const requestedAuthorPage = String(state.shortVideo.authorPage || "").trim(); const currentRequest = () => isCurrentShortVideoLoadRequest(requestId, shortVideoListRequestId, requestedAuthorPage, state.shortVideo.authorPage, isShortVideoAuthorDetailPage());
    if (!append && requestedAuthorPage) {
      resolveShortVideoAuthor(requestedAuthorPage).then((author) => {
        if (requestId !== shortVideoListRequestId || state.shortVideo.authorPage !== requestedAuthorPage || !author) return;
        state.shortVideo.authorDetail = { ...(state.shortVideo.authorDetail || {}), ...author };
        renderView();
      }).catch(() => {});
    }
    const data = await settleShortVideoLoad(api(`/api/short-videos?${params}`), currentRequest); if (data === SHORT_VIDEO_LOAD_STALE) return data;
    if (captureListPerformance) {
      markShortVideoPerformance("short-video-list-request-finish", {
        append,
        requestId,
        currentRequestId: shortVideoListRequestId,
        durationMs: Date.now() - listRequestStartedAt,
        received: Array.isArray(data?.videos) ? data.videos.length : 0,
        hasMore: Boolean(data?.hasMore)
      });
    }
    if (!currentRequest()) {
      if (captureListPerformance) {
        markShortVideoPerformance("short-video-list-request-stale", {
          append,
          requestId,
          currentRequestId: shortVideoListRequestId
        });
      }
      return SHORT_VIDEO_LOAD_STALE;
    }
    if (append && state.shortVideo.data) {
      const previousUsers = Array.isArray(state.shortVideo.data.users) ? state.shortVideo.data.users : [];
      const previousUsersTotal = Math.max(0, Number(state.shortVideo.data.usersTotal || 0));
      const previousUsersHasMore = Boolean(state.shortVideo.data.usersHasMore);
      const stableTotal = appendCursor
        ? Math.max(0, Number(state.shortVideo.data.total || 0))
        : Math.max(0, Number(data.total || 0));
      const seen = new Set((state.shortVideo.data.videos || []).map((video) => video.id));
      const merged = [...(state.shortVideo.data.videos || [])];
      for (const video of data.videos || []) {
        if (seen.has(video.id)) continue;
        seen.add(video.id);
        merged.push(video);
      }
      state.shortVideo.data = {
        ...data,
        total: stableTotal,
        users: previousUsers,
        usersTotal: previousUsersTotal,
        usersHasMore: previousUsersHasMore,
        videos: merged,
        offset: 0,
        limit: merged.length
      };
    } else {
      state.shortVideo.data = data;
    }
    if (!isShortVideoAuthorDetailPage()) {
      state.shortVideo.source = normalizeShortVideoSource(data.source || state.shortVideo.source);
    }
    state.shortVideo.topic = normalizeShortVideoTopic(data.topic || state.shortVideo.topic);
    state.shortVideo.sound = normalizeShortVideoSound(data.sound || state.shortVideo.sound);
    if (state.shortVideo.sound) {
      state.shortVideo.soundInfo = (data.videos || []).find((video) => video?.sound?.key === state.shortVideo.sound)?.sound || state.shortVideo.soundInfo;
    }
    state.shortVideo.media = normalizeShortVideoMedia(data.media || state.shortVideo.media);
    state.shortVideo.quality = normalizeShortVideoQuality(data.quality || state.shortVideo.quality);
    state.shortVideo.deleted = normalizeShortVideoDeleted(data.deleted || state.shortVideo.deleted);
    if (state.shortVideo.quality !== "all") state.shortVideo.media = "video";
    if (Array.isArray(data.authors) && data.authors.length) state.shortVideo.authors = data.authors;
    state.shortVideo.summary = data.summary || state.shortVideo.summary;
    state.shortVideo.loading = false;
    state.shortVideo.loadingMore = false;
    state.shortVideo.status = data.total
      ? ""
      : (state.shortVideo.source === "following"
        ? "还没有关注的作者。打开任一作品，点击头像下方的加号即可关注。"
        : state.shortVideo.source === "history"
          ? "还没有观看记录。打开视频或图文后会自动出现在这里。"
          : state.shortVideo.source === "recommended"
            ? "暂时没有推荐内容。可以在全部作品中撤销“不感兴趣”。"
        : "还没有短视频。");
    renderStats();
    if (append) {
      renderShortVideoWindow(false);
      scheduleShortVideoWindowUpdate();
      scheduleShortVideoAppendContinuation();
    } else {
      renderView();
    }
    if (captureListPerformance) {
      markShortVideoPerformance("short-video-list-applied", {
        append,
        requestId,
        videos: Array.isArray(state.shortVideo.data?.videos) ? state.shortVideo.data.videos.length : 0,
        visibleVideos: shortVideosWithCovers(state.shortVideo.data?.videos || []).length,
        hasMore: Boolean(state.shortVideo.data?.hasMore),
        durationMs: Date.now() - listRequestStartedAt
      });
    }
    if (!options.skipRoute) {
      const writer = options.replaceRoute ? replaceRoute : pushRoute;
      writer({
        view: "shortVideos",
        shortVideoId: "",
        shortVideoAuthorPage: state.shortVideo.authorPage || "",
        shortVideoMode: state.shortVideo.mode || "feed",
        shortVideoQuery: state.shortVideo.query || "",
        shortVideoTopic: state.shortVideo.topic || "",
        shortVideoSound: state.shortVideo.sound || "",
        shortVideoAuthor: state.shortVideo.author || "all",
        shortVideoMedia: state.shortVideo.media || "all",
        shortVideoQuality: state.shortVideo.quality || "all",
        shortVideoDeleted: state.shortVideo.deleted || "all",
        shortVideoAuthorAccountStatus: state.shortVideo.authorAccountStatus || "all",
        shortVideoSource: state.shortVideo.source || "liked",
        shortVideoSort: state.shortVideo.sort || "published"
      });
    }
    if (!append) loadShortVideoSummary().catch(handleSummaryLoadError);
  }

  async function loadShortVideoSummary() {
    ensureState();
    if (state.shortVideo.summary || state.shortVideo.summaryLoading) return;
    state.shortVideo.summaryLoading = true;
    try {
      const data = await api("/api/short-videos/summary");
      state.shortVideo.summary = data || state.shortVideo.summary;
      if (state.shortVideo.data) {
        state.shortVideo.data = { ...state.shortVideo.data, summary: state.shortVideo.summary };
      }
      renderStats();
    } finally {
      state.shortVideo.summaryLoading = false;
    }
  }

  async function openVideo(videoId, options = {}) {
    ensureState();
    if (!videoId) return;
    cancelAuthorCollectorPolling();
    const requestId = ++shortVideoOpenRequestId;
    const openStartedAt = Date.now();
    const viewerStylesReady = Promise.resolve(ensureShortVideoViewerStyles?.()).catch(() => false);
    if (document.documentElement.dataset.shortVideoPerfCapture === "1") {
      viewerStylesReady.then(() => markShortVideoPerformance("video-viewer-styles-ready", {
        videoId: String(videoId),
        requestId,
        durationMs: Date.now() - openStartedAt
      }));
    }
    markShortVideoPerformance("video-open-start", {
      videoId: String(videoId),
      requestId
    });
    shortVideoOpeningId = String(videoId);
    shortVideoOpenError = "";
    const feedVideos = Array.isArray(state.shortVideo.data?.videos) ? state.shortVideo.data.videos : [];
    const feedIndex = feedVideos.findIndex((video) => String(video?.id || "") === String(videoId));
    const openingVideo = state.shortVideo.mode === "collection"
      ? null
      : options.video || cachedShortVideo(videoId) || (feedIndex >= 0 ? feedVideos[feedIndex] : null);
    if (openingVideo?.id) {
      markShortVideoPerformance("video-open-fast-path", {
        videoId: String(openingVideo.id),
        requestId,
        feedIndex
      });
      rememberShortVideo(openingVideo);
      prewarmShortVideoPlayback(openingVideo).catch(() => {});
      await viewerStylesReady;
      if (requestId !== shortVideoOpenRequestId) return false;
      const collectionNavigation = collectionsController.collectionNavigation(openingVideo.id);
      const navigation = collectionNavigation || cachedShortVideoNavigation(openingVideo.id);
      const feedPrevious = feedIndex > 0 ? feedVideos[feedIndex - 1] : null;
      const feedNext = feedIndex >= 0 && feedIndex < feedVideos.length - 1 ? feedVideos[feedIndex + 1] : null;
      const previousId = navigation?.prevId || String(feedPrevious?.id || "");
      const nextId = navigation?.nextId || String(feedNext?.id || "");
      state.shortVideo.current = openingVideo;
      state.shortVideo.prevId = previousId;
      state.shortVideo.nextId = nextId;
      state.shortVideo.prevVideo = collectionNavigation?.prevVideo || cachedShortVideo(previousId) || feedPrevious || null;
      state.shortVideo.nextVideo = collectionNavigation?.nextVideo || cachedShortVideo(nextId) || feedNext || null;
      rememberShortVideo(state.shortVideo.prevVideo);
      rememberShortVideo(state.shortVideo.nextVideo);
      state.shortVideo.slideDirection = Number(options.slideDirection || 0);
      state.shortVideo.loading = false;
      state.shortVideo.status = "";
      shortVideoOpeningId = "";
      renderStats();
      renderView();
      markShortVideoPerformance("video-rendered", {
        videoId: String(openingVideo.id),
        requestId,
        source: "cached-feed",
        durationMs: Date.now() - openStartedAt
      });
      resumeActiveSound();
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      if (!options.skipRoute) pushRoute({ view: "shortVideos", shortVideoId: openingVideo.id });
      loadShortVideoSummary().catch(handleSummaryLoadError);
      hydratePromotedShortVideo(openingVideo).catch((error) => console.warn(error));
      return true;
    }
    state.shortVideo.loading = true;
    state.shortVideo.status = "正在打开视频";
    const detailPromise = options.detailData
      ? Promise.resolve(options.detailData)
      : contextualShortVideoDetail(videoId);
    try {
      if (options.renderLoading !== false) {
        await viewerStylesReady;
        if (requestId !== shortVideoOpenRequestId) {
          detailPromise.catch(() => {});
          return false;
        }
        renderView();
      }
      const [data] = await Promise.all([detailPromise, viewerStylesReady]);
      if (requestId !== shortVideoOpenRequestId) return false;
      markShortVideoPerformance("video-detail-ready", {
        videoId: String(data?.video?.id || videoId),
        requestId,
        durationMs: Date.now() - openStartedAt
      });
      state.shortVideo.current = data.video;
      if (state.shortVideo.sound && data.video?.sound?.key === state.shortVideo.sound) state.shortVideo.soundInfo = data.video.sound;
      const collectionNavigation = collectionsController.collectionNavigation(data.video.id);
      state.shortVideo.prevId = collectionNavigation?.prevId || data.prevId || "";
      state.shortVideo.nextId = collectionNavigation?.nextId || data.nextId || "";
      state.shortVideo.slideDirection = Number(options.slideDirection || 0);
      state.shortVideo.prevVideo = collectionNavigation?.prevVideo || data.prevVideo || null;
      state.shortVideo.nextVideo = collectionNavigation?.nextVideo || data.nextVideo || null;
      state.shortVideo.loading = false;
      state.shortVideo.status = "";
      shortVideoOpeningId = "";
      shortVideoOpenError = "";
      renderStats();
      renderView();
      markShortVideoPerformance("video-rendered", {
        videoId: String(data.video.id),
        requestId,
        source: "detail",
        durationMs: Date.now() - openStartedAt
      });
      resumeActiveSound();
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      if (!options.skipRoute) pushRoute({ view: "shortVideos", shortVideoId: data.video.id });
      loadShortVideoSummary().catch(handleSummaryLoadError);
      loadAdjacentVideos(data.video.id).then((loaded) => {
        if (!loaded) return;
        scheduleInitialAdjacentPanelsRefresh(data.video.id);
      }).catch((error) => console.warn(error));
      return true;
    } catch (error) {
      if (requestId !== shortVideoOpenRequestId) return false;
      markShortVideoPerformance("video-open-error", {
        videoId: String(videoId),
        requestId,
        durationMs: Date.now() - openStartedAt,
        message: String(error?.message || error || "")
      });
      state.shortVideo.loading = false;
      state.shortVideo.status = "";
      if (state.shortVideo.current) {
        shortVideoOpeningId = "";
        shortVideoOpenError = "";
        renderView();
        throw error;
      }
      shortVideoOpenError = shortVideoFriendlyError(error, "本地视频暂时无法打开");
      renderView();
      console.warn(error);
      return false;
    }
  }

  function renderStats() {
    ensureState();
    if (!els.statsRow) return;
    els.statsRow.innerHTML = "";
    els.statsRow.hidden = state.shortVideo.mode === "transcoding";
    if (els.statsRow.hidden) return;
    const totals = state.shortVideo.summary?.totals || state.shortVideo.data?.summary?.totals || {};
    for (const [label, value] of [
      ["视频", formatNumber(totals.videos || 0)],
      ["作者", formatNumber(totals.authors || 0)],
      ["容量", formatBytes(totals.bytes || 0)],
      ["时长", formatDuration(totals.durationMs || 0)]
    ]) {
      const stat = document.createElement("div");
      stat.className = "stat short-video-stat";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const span = document.createElement("span");
      span.textContent = label;
      stat.append(strong, span);
      els.statsRow.append(stat);
    }
  }

  function preserveShortVideoHomeDuringLoad(append) {
    if (append) return false;
    const home = els.workGrid?.querySelector?.(".short-video-home");
    if (!home) return false;
    home.setAttribute("aria-busy", "true");
    const activeSource = state.shortVideo.source || "liked";
    for (const button of home.querySelectorAll(".short-video-source-tab")) {
      const active = button.dataset.source === activeSource;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    return true;
  }

  function renderView() {
    ensureState();
    if (!els.workGrid) return;
    resetShortVideoWindow();
    clearPendingPlayerClick();
    els.workGrid.querySelector?.(".short-video-browser")?.shortVideoControlsDispose?.();
    els.workGrid.querySelector?.(".short-video-control-bar")?.shortVideoDispose?.();
    disposeShortVideoMedia(els.workGrid);
    els.workGrid.innerHTML = "";
    if (state.shortVideo.mode !== "transcoding") transcodeManagementPage.stop();
    setBodyClass();
    if (state.shortVideo.mode === "transcoding") {
      transcodeManagementPage.render();
      return;
    }
    if (state.shortVideo.mode === "likes") {
      renderLikeDistributionPage();
      return;
    }
    if (state.shortVideo.current) {
      renderBrowser();
      return;
    }
    if (shortVideoOpeningId) {
      renderBrowserLoading();
      return;
    }
    if (state.shortVideo.mode === "collection") {
      els.workGrid.append(collectionsController.renderCollectionPage());
      return;
    }
    renderHome();
  }

  function ensureShortVideoListCards() {
    if (shortVideoListCards) return Promise.resolve(shortVideoListCards);
    if (shortVideoListCardsPromise) return shortVideoListCardsPromise;
    markShortVideoPerformance("list-cards-module-start");
    const moduleUrl = "/modules/short-videos/list-cards.js?v=20260810-author-account-status-01";
    shortVideoListCardsPromise = import(moduleUrl).then((module) => {
      if (typeof module.createShortVideoListCards !== "function") {
        throw new Error("短视频列表模块加载失败");
      }
      shortVideoListCards = module.createShortVideoListCards({
        applyShortVideoLikeBadgeState,
        authorScopeId,
        cardTitle,
        coverEagerCount,
        createIcon,
        ensureShortVideoViewerStyles,
        formatDate,
        formatDuration,
        formatNumber,
        formatSeconds,
        formatShortVideoMetric,
        galleryBadge,
        galleryLabel,
        initials,
        isGalleryPost,
        isShortVideoAuthorDetailPage,
        openShortVideoAuthorPage,
        openVideo,
        prewarmShortVideoPlayback,
        rememberShortVideo,
        shortVideoAuthorHandle,
        shortVideoCardCoverUrl,
        shortVideoDeleteSelection,
        showError,
        state,
        toggleShortVideoSelected
      });
      markShortVideoPerformance("list-cards-module-ready");
      return shortVideoListCards;
    }).catch((error) => {
      shortVideoListCardsPromise = null;
      markShortVideoPerformance("list-cards-module-error", {
        message: String(error?.message || error || "unknown")
      });
      throw error;
    });
    return shortVideoListCardsPromise;
  }

  function renderHome() {
    const data = state.shortVideo.data || {};
    const needsListCards = isShortVideoAuthorIndexPage()
      ? Boolean(state.shortVideo.authors?.length)
      : shortVideosWithCovers(data.videos || []).length > 0 || Boolean(data.users?.length);
    if (needsListCards && !shortVideoListCards) {
      const loading = document.createElement("section");
      loading.className = "short-video-home";
      const status = document.createElement("div");
      status.className = "short-video-status";
      status.setAttribute("role", "status");
      status.textContent = "正在准备短视频列表…";
      loading.append(status);
      els.workGrid.append(loading);
      ensureShortVideoListCards().then(() => {
        if (state.activeView === "shortVideos" && !state.shortVideo?.current && !shortVideoOpeningId) renderView();
      }).catch(showError);
      return;
    }
    const shell = document.createElement("section");
    shell.className = "short-video-home";
    shell.classList.toggle("is-author-page", isShortVideoAuthorDetailPage());
    const layout = document.createElement("div");
    layout.className = "short-video-home-layout";
    const content = document.createElement("section");
    content.className = "short-video-home-main";
    layout.append(collectionsController.renderSidebar(), content);
    shell.append(layout);
    if (!isShortVideoAuthorDetailPage()) {
      content.append(isShortVideoAuthorIndexPage()
        ? renderShortVideoAuthorIndexSearch()
        : renderShortVideoDiscovery());
    }
    content.append(renderHomeToolbar(data));
    if (isShortVideoAuthorIndexPage()) {
      content.append(renderAuthorIndex());
      els.workGrid.append(shell);
      return;
    }
    if (isShortVideoAuthorDetailPage()) {
      content.append(renderAuthorDetailHome(data), renderAuthorWorkspaceToolbar(data));
    }
    if (state.shortVideo.query && !isShortVideoAuthorDetailPage()) {
      content.append(renderAggregateSearchResults(data));
    }
    if (state.shortVideo.status && !(data.videos || []).length) {
      const status = document.createElement("div");
      status.className = "short-video-status";
      status.textContent = state.shortVideo.status;
      content.append(status);
    }
    const grid = document.createElement("div");
    let inner = null;
    const displayVideos = shortVideosWithCovers(data.videos || []);
    if (!displayVideos.length) {
      grid.className = "short-video-grid";
      grid.append(renderShortVideoEmpty(data));
    } else {
      grid.className = "short-video-grid short-video-virtual-grid";
      inner = document.createElement("div");
      inner.className = "short-video-window";
      grid.append(inner);
    }
    content.append(grid);
    els.workGrid.append(shell);
    attachShortVideoWindow(grid, inner);
    renderShortVideoWindow(true);
  }

  function renderShortVideoAuthorIndexSearch() {
    const section = document.createElement("section");
    section.className = "short-video-discovery short-video-author-index-search";
    const following = state.shortVideo.source === "following";
    section.append(shortVideoSearch.renderForm({
      ariaLabel: following ? "搜索我的关注作者" : "搜索短视频作者",
      onSubmit: commitShortVideoAuthorIndexSearch,
      placeholder: following ? "搜索我的关注作者" : "搜索作者",
      suggestions: false
    }));
    return section;
  }

  function commitShortVideoAuthorIndexSearch(value) {
    const source = state.shortVideo.source === "following" ? "following" : "authors";
    state.shortVideo.source = source;
    state.shortVideo.authorIndexSource = source;
    commitShortVideoSearch(value);
  }

  function renderShortVideoDiscovery() {
    const section = document.createElement("section");
    section.className = "short-video-discovery";
    const form = shortVideoSearch.renderForm();

    const media = document.createElement("div");
    media.className = "short-video-media-filter";
    media.setAttribute("role", "group");
    media.setAttribute("aria-label", "筛选作品类型");
    for (const [value, label] of [["all", "全部"], ["video", "视频"], ["gallery", "图文"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-media-filter-button";
      const active = normalizeShortVideoMedia(state.shortVideo.media) === value;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = label;
      button.addEventListener("click", () => commitShortVideoMedia(value));
      media.append(button);
    }
    const quality = document.createElement("label");
    quality.className = "short-video-quality-filter";
    const qualityLabel = document.createElement("span");
    qualityLabel.textContent = "清晰度";
    const qualitySelect = document.createElement("select");
    qualitySelect.setAttribute("aria-label", "按实际视频清晰度筛选");
    for (const [value, label] of [
      ["all", "全部"],
      ["4k", "4K"],
      ["1440p", "2K / 1440P"],
      ["1080p", "1080P"],
      ["720p", "720P"],
      ["below720p", "低于 720P"],
      ["unknown", "未检测"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = normalizeShortVideoQuality(state.shortVideo.quality) === value;
      qualitySelect.append(option);
    }
    qualitySelect.addEventListener("change", () => commitShortVideoQuality(qualitySelect.value));
    quality.append(qualityLabel, qualitySelect);

    const distribution = document.createElement("button");
    distribution.type = "button";
    distribution.className = "short-video-distribution-toggle";
    distribution.append(createIcon("chart"), document.createTextNode("数据统计"));
    distribution.title = "在新标签页打开独立的短视频数据统计页面";
    distribution.addEventListener("click", openLikeDistributionPage);
    const transcodeStatus = createShortVideoTranscodeStatusButton({ api, createIcon, formatBytes });

    section.append(form, media, quality, distribution, transcodeStatus);
    if (state.shortVideo.topic) {
      const topic = document.createElement("div");
      topic.className = "short-video-active-topic";
      const label = document.createElement("span");
      label.append(createIcon("link"), document.createTextNode(`#${state.shortVideo.topic}`));
      const clearTopic = document.createElement("button");
      clearTopic.type = "button";
      clearTopic.setAttribute("aria-label", `退出话题 ${state.shortVideo.topic}`);
      clearTopic.append(createIcon("close"));
      clearTopic.addEventListener("click", () => commitShortVideoTopic(""));
      topic.append(label, clearTopic);
      section.append(topic);
    }
    if (state.shortVideo.sound) {
      const soundInfo = state.shortVideo.soundInfo || {};
      const sound = document.createElement("div");
      sound.className = "short-video-active-sound";
      const label = document.createElement("span");
      label.append(createIcon("headphones"), document.createTextNode(soundInfo.title || "原声流"));
      const clearSound = document.createElement("button");
      clearSound.type = "button";
      clearSound.setAttribute("aria-label", `退出原声 ${soundInfo.title || "原声流"}`);
      clearSound.append(createIcon("close"));
      clearSound.addEventListener("click", () => commitShortVideoSound(""));
      sound.append(label, clearSound);
      section.append(sound);
    }
    return section;
  }

  function renderAggregateSearchResults(data = {}) {
    const section = document.createElement("section");
    section.className = "short-video-aggregate-results";
    section.setAttribute("aria-label", "综合搜索结果");

    const userHeader = document.createElement("div");
    userHeader.className = "short-video-search-section-head";
    const userTitle = document.createElement("h2");
    userTitle.textContent = "用户";
    const userCount = document.createElement("span");
    const usersTotal = Math.max(0, Number(data.usersTotal || 0));
    userCount.textContent = usersTotal
      ? `${formatNumber(usersTotal)} 位匹配用户${data.usersHasMore ? "，展示前 6 位" : ""}`
      : "没有匹配用户";
    userHeader.append(userTitle, userCount);

    const users = document.createElement("div");
    users.className = "short-video-search-users";
    for (const author of Array.isArray(data.users) ? data.users : []) {
      const card = renderSearchUserCard(author);
      if (card) users.append(card);
    }
    if (!users.childElementCount) {
      const empty = document.createElement("p");
      empty.className = "short-video-search-users-empty";
      empty.textContent = "本地用户库里暂时没有匹配项。";
      users.append(empty);
    }

    const workHeader = document.createElement("div");
    workHeader.className = "short-video-search-section-head is-works";
    const workTitle = document.createElement("h2");
    workTitle.textContent = "作品";
    const workCount = document.createElement("span");
    workCount.textContent = `${formatNumber(data.total || 0)} 条匹配作品`;
    workHeader.append(workTitle, workCount);
    section.append(userHeader, users, workHeader);
    return section;
  }

  function openLikeDistributionPage() {
    window.open("/short-videos/stats/likes", "_blank", "noopener,noreferrer");
  }

  function isLikeDistributionAuthorTableRoute() {
    return window.location.hash === "#authors"
      || String(window.location.pathname || "").replace(/\/+$/g, "").endsWith("/short-videos/stats/likes/authors");
  }

  function leaveLikeDistributionPage() {
    state.shortVideo.mode = "feed";
    replaceRoute({
      shortVideoId: "",
      shortVideoAuthorPage: "",
      shortVideoMode: "feed"
    });
    setMainHeader("短视频", "抖音点赞本地库");
    renderView();
    if (!state.shortVideo.data) loadVideos({ skipRoute: true }).catch(showError);
  }

  function openLikeDistributionAuthor(item = {}) {
    const secUid = String(item.authorSecUid || item.secUid || "").trim();
    if (!secUid) return;
    openShortVideoAuthorPage({
      secUid,
      name: item.authorName || item.name || "未知作者"
    }, item.id ? {
      id: item.id,
      author: { secUid, name: item.authorName || item.name || "未知作者" }
    } : {});
  }

  function openLikeDistributionTopic(item = {}) {
    state.shortVideo.mode = "feed";
    setMainHeader("短视频", "抖音点赞本地库");
    commitShortVideoTopic(item.label || item.key || "");
  }

  function ensureLikeDistributionView() {
    if (likeDistributionViewPromise) return likeDistributionViewPromise;
    const moduleUrl = "/modules/short-videos/like-distribution-view.js?v=20260825-author-efficiency-03";
    likeDistributionViewPromise = import(moduleUrl).then((module) => {
      if (typeof module.createLikeDistributionView !== "function") {
        throw new Error("内容洞察模块加载失败");
      }
      return module.createLikeDistributionView({
        api, deleteRecovery: deleteRecoveryController, formatNumber,
        loadLikeDistribution,
        openInsightAuthor: openLikeDistributionAuthor,
        openInsightTopic: openLikeDistributionTopic,
        showError, showToast: showBrowserToast,
        state
      });
    }).catch((error) => {
      likeDistributionViewPromise = null;
      throw error;
    });
    return likeDistributionViewPromise;
  }

  function renderLikeDistributionPage() {
    const authorEfficiencyTable = isLikeDistributionAuthorTableRoute(), renderToken = ++likeDistributionRenderToken;
    renderLikeDistributionPageShell({
      authorEfficiencyTable,
      createIcon,
      els,
      ensureView: ensureLikeDistributionView,
      isCurrent: () => renderToken === likeDistributionRenderToken,
      onLeave: authorEfficiencyTable ? () => window.location.assign("/short-videos/stats/likes") : leaveLikeDistributionPage,
      state
    });
  }
  function commitShortVideoSearch(value, options = {}) {
    const query = String(value || "").trim().slice(0, 120);
    shortVideoSearch.remember(query);
    const globalScopeChanged = Boolean(options.global && (
      state.shortVideo.author !== "all"
      || state.shortVideo.authorPage
      || state.shortVideo.source !== "all"
      || state.shortVideo.media !== "all"
      || state.shortVideo.quality !== "all"
    ));
    if (options.global) {
      state.shortVideo.author = "all";
      state.shortVideo.authorPage = "";
      state.shortVideo.source = "all";
      state.shortVideo.media = "all";
      state.shortVideo.quality = "all";
    }
    if (!globalScopeChanged && query === (state.shortVideo.query || "") && !state.shortVideo.topic && !state.shortVideo.sound && state.shortVideo.data) return;
    state.shortVideo.query = query;
    state.shortVideo.topic = "";
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    state.shortVideo.current = null;
    clearShortVideoDeleteSelection();
    loadVideos({ replaceRoute: !options.pushRoute }).catch(showError);
  }

  function commitShortVideoTopic(value) {
    const topic = normalizeShortVideoTopic(value);
    if (topic === normalizeShortVideoTopic(state.shortVideo.topic) && state.shortVideo.data) return;
    state.shortVideo.topic = topic;
    state.shortVideo.query = "";
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    state.shortVideo.author = "all";
    if (topic) {
      state.shortVideo.source = "all";
      state.shortVideo.sort = "likes";
    }
    state.shortVideo.current = null;
    clearShortVideoDeleteSelection();
    loadVideos({ replaceRoute: true }).catch(showError);
  }

  function commitShortVideoSound(value, info = null) {
    const sound = normalizeShortVideoSound(value);
    if (sound === normalizeShortVideoSound(state.shortVideo.sound) && state.shortVideo.data) return;
    state.shortVideo.sound = sound;
    state.shortVideo.soundInfo = sound && info ? info : null;
    state.shortVideo.query = "";
    state.shortVideo.topic = "";
    state.shortVideo.author = "all";
    if (sound) {
      state.shortVideo.source = "all";
      state.shortVideo.sort = "likes";
    }
    state.shortVideo.current = null;
    clearShortVideoDeleteSelection();
    loadVideos({ replaceRoute: true }).catch(showError);
  }

  function commitShortVideoMedia(value) {
    const media = normalizeShortVideoMedia(value);
    const nextQuality = media === "video" ? state.shortVideo.quality : "all";
    if (media === normalizeShortVideoMedia(state.shortVideo.media)
      && nextQuality === normalizeShortVideoQuality(state.shortVideo.quality)) return;
    state.shortVideo.media = media;
    state.shortVideo.quality = nextQuality;
    state.shortVideo.current = null;
    clearShortVideoDeleteSelection();
    loadVideos({ replaceRoute: true }).catch(showError);
  }

  function commitShortVideoQuality(value) {
    const quality = normalizeShortVideoQuality(value);
    if (quality === normalizeShortVideoQuality(state.shortVideo.quality)) return;
    state.shortVideo.quality = quality;
    if (quality !== "all") state.shortVideo.media = "video";
    state.shortVideo.current = null;
    clearShortVideoDeleteSelection();
    loadVideos({ replaceRoute: true }).catch(showError);
  }

  function renderShortVideoEmpty(data = {}) {
    const empty = document.createElement("div");
    empty.className = "short-video-empty";
    if (state.shortVideo.loading) {
      empty.classList.add("is-loading");
      empty.textContent = "正在读取短视频";
      return empty;
    }
    if ((data.videos || []).length) {
      empty.textContent = "封面补齐前暂不显示这些短视频。";
      return empty;
    }
    const query = String(state.shortVideo.query || "").trim();
    const topic = normalizeShortVideoTopic(state.shortVideo.topic);
    const sound = normalizeShortVideoSound(state.shortVideo.sound);
    const media = normalizeShortVideoMedia(state.shortVideo.media);
    const quality = normalizeShortVideoQuality(state.shortVideo.quality);
    const deleted = normalizeShortVideoDeleted(state.shortVideo.deleted);
    const title = document.createElement("h2");
    title.textContent = query
      ? `没有找到“${query}”`
      : topic
        ? `没有找到 #${topic} 的本地作品`
      : sound
        ? `没有找到“${state.shortVideo.soundInfo?.title || "当前原声"}”的本地作品`
      : quality !== "all"
        ? `没有找到${shortVideoQualityLabel(quality)}视频`
      : deleted === "deleted"
        ? "没有找到已从作者主页删除的本地作品"
      : media === "gallery"
        ? "没有找到图文作品"
        : media === "video"
          ? "没有找到视频作品"
          : state.shortVideo.status || "没有匹配的短视频";
    const hint = document.createElement("p");
    hint.textContent = query || topic || sound || media !== "all" || deleted !== "all"
      ? "试试更短的关键词，或者调整作品类型。"
      : "本地库暂时没有可展示的内容。";
    const actions = document.createElement("div");
    actions.className = "short-video-empty-actions";
    if (query) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "清除搜索";
      clear.addEventListener("click", () => commitShortVideoSearch(""));
      actions.append(clear);
    }
    if (media !== "all") {
      const all = document.createElement("button");
      all.type = "button";
      all.textContent = "查看全部类型";
      all.addEventListener("click", () => commitShortVideoMedia("all"));
      actions.append(all);
    }
    if (topic) {
      const exitTopic = document.createElement("button");
      exitTopic.type = "button";
      exitTopic.textContent = "退出话题";
      exitTopic.addEventListener("click", () => commitShortVideoTopic(""));
      actions.append(exitTopic);
    }
    if (sound) {
      const exitSound = document.createElement("button");
      exitSound.type = "button";
      exitSound.textContent = "退出原声流";
      exitSound.addEventListener("click", () => commitShortVideoSound(""));
      actions.append(exitSound);
    }
    empty.append(title, hint);
    if (actions.childElementCount) empty.append(actions);
    return empty;
  }

  function renderHomeToolbar(data = {}) {
    const toolbar = document.createElement("div");
    toolbar.className = "short-video-home-toolbar";
    const tabs = document.createElement("div");
    tabs.className = "short-video-source-tabs";
    const activeSource = isShortVideoAuthorDetailPage()
      ? state.shortVideo.authorIndexSource
      : (state.shortVideo.source || "liked");
    for (const [groupLabel, groupClass, items] of [
      ["内容", "is-feed", [
        ["recommended", "推荐"],
        ["liked", "我的喜欢"],
        ["history", "历史"],
        ["all", "全部"]
      ]],
      ["作者", "is-authors", [
        ["following", "我的关注"],
        ["authors", "作者"]
      ]]
    ]) {
      const group = document.createElement("div");
      group.className = `short-video-source-tab-group ${groupClass}`;
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", groupLabel);
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "short-video-source-tab";
        button.dataset.source = item[0];
        const active = activeSource === item[0];
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
        button.textContent = item[1];
        button.addEventListener("click", () => {
          if (activeSource === item[0] && !isShortVideoAuthorDetailPage()) return;
          if (isShortVideoAuthorDetailPage()) state.shortVideo.authorIndexWindow = null;
          state.shortVideo.authorPage = "";
          state.shortVideo.source = item[0];
          state.shortVideo.topic = "";
          state.shortVideo.sound = "";
          state.shortVideo.soundInfo = null;
          if (item[0] === "recommended") {
            state.shortVideo.sort = "recommended";
          } else if (item[0] === "history") {
            state.shortVideo.sort = "watched";
          } else if (["recommended", "watched"].includes(state.shortVideo.sort)) {
            state.shortVideo.sort = "published";
          }
          if (["authors", "following"].includes(item[0])) {
            state.shortVideo.authorIndexSource = item[0];
            state.shortVideo.author = "all";
            state.shortVideo.query = "";
            state.shortVideo.media = "all";
            state.shortVideo.quality = "all";
          } else {
            state.shortVideo.author = "all";
          }
          state.shortVideo.current = null;
          clearShortVideoDeleteSelection();
          pushRoute({
            view: "shortVideos",
            shortVideoId: "",
            shortVideoAuthorPage: "",
            shortVideoAuthor: state.shortVideo.author,
            shortVideoQuery: state.shortVideo.query,
            shortVideoSource: state.shortVideo.source
          });
          loadVideos({ skipRoute: true }).catch(showError);
        });
        group.append(button);
      }
      tabs.append(group);
    }
    const actions = isShortVideoAuthorDetailPage()
      ? document.createElement("div")
      : state.shortVideo.source === "following" && isShortVideoAuthorIndexPage()
        ? renderFollowingAuthorControls()
        : state.shortVideo.source === "authors" && isShortVideoAuthorIndexPage()
          ? renderAuthorAccountStatusControl()
          : renderDeleteSelectionActions(data);
    const total = document.createElement("div");
    total.className = "short-video-home-total";
    if (isShortVideoAuthorIndexPage()) {
      const loadedCount = state.shortVideo.authors.length;
      const authorTotal = state.shortVideo.authorTotal;
      if (state.shortVideo.source === "following") {
        const scopeTotal = state.shortVideo.authorScopeTotal || authorTotal;
        const unlikedTotal = state.shortVideo.authorUnlikedTotal;
        total.textContent = state.shortVideo.loading
          ? "正在读取关注账号"
          : `关注 ${formatNumber(scopeTotal)} · 未点赞 ${formatNumber(unlikedTotal)}${state.shortVideo.authorHasMore ? ` · 已显示 ${formatNumber(loadedCount)}` : ""}`;
      } else {
        const bannedOnly = state.shortVideo.authorAccountStatus === "banned";
        const scopeTotal = state.shortVideo.authorScopeTotal || authorTotal;
        total.textContent = state.shortVideo.loading
          ? "正在读取作者"
          : bannedOnly
            ? `已封禁 ${formatNumber(authorTotal)} / 全部 ${formatNumber(scopeTotal)} 位作者`
          : state.shortVideo.authorHasMore
            ? `已显示 ${formatNumber(loadedCount)} / ${formatNumber(authorTotal)} 位作者`
            : `${formatNumber(authorTotal || loadedCount)} 位作者`;
      }
    } else if (isShortVideoAuthorDetailPage()) {
      total.textContent = `${formatNumber(data.total || 0)} 条作品`;
    } else if (
      state.shortVideo.source === "liked"
      && Number(data.relationshipTotal || 0) > Number(data.total || 0)
    ) {
      total.textContent = `喜欢关系 ${formatNumber(data.relationshipTotal)} · 本地可看 ${formatNumber(data.total || 0)}`;
    } else {
      total.textContent = `${formatNumber(data.total || 0)} 条`;
    }
    toolbar.append(tabs, actions, total);
    return toolbar;
  }

  function renderDeleteSelectionActions(data = {}) {
    const wrap = document.createElement("div");
    wrap.className = "short-video-delete-actions";
    if (isShortVideoAuthorIndexPage()) return wrap;
    if (isShortVideoAuthorDetailPage()) wrap.append(renderShortVideoDeletedControl(data));
    wrap.append(renderShortVideoSortControl());
    const selection = shortVideoDeleteSelection();
    if (!state.shortVideo.deleteMode) {
      const collect = document.createElement("button");
      collect.type = "button";
      collect.className = "short-video-delete-tool";
      collect.append(createIcon("external"), document.createTextNode("采集管理"));
      collect.addEventListener("click", () => {
        const secUid = isShortVideoAuthorDetailPage()
          ? String(state.shortVideo.authorPage || state.shortVideo.author || "").trim()
          : "";
        const managerUrl = secUid
          ? `http://127.0.0.1:8765/?profile=${encodeURIComponent(secUid)}#profiles`
          : "http://127.0.0.1:8765/#home";
        window.open(managerUrl, "_blank", "noopener,noreferrer");
      });
      const start = document.createElement("button");
      start.type = "button";
      start.className = "short-video-delete-tool";
      start.append(createIcon("trash"), document.createTextNode("选择删除"));
      start.addEventListener("click", () => {
        state.shortVideo.deleteMode = true;
        refreshShortVideoDeleteSelectionUi();
      });
      wrap.append(collect, start);
      return wrap;
    }
    const loadedIds = shortVideosWithCovers(data.videos || []).map((video) => String(video.id || "")).filter(Boolean);
    const allLoadedSelected = loadedIds.length > 0 && loadedIds.every((id) => selection.has(id));
    const selectLoaded = document.createElement("button");
    selectLoaded.type = "button";
    selectLoaded.className = "short-video-delete-tool";
    selectLoaded.textContent = allLoadedSelected ? "取消全选" : "全选已加载";
    selectLoaded.disabled = !loadedIds.length;
    selectLoaded.addEventListener("click", () => {
      toggleLoadedShortVideoSelection(loadedIds, allLoadedSelected);
    });
    const commit = document.createElement("button");
    commit.type = "button";
    commit.className = "short-video-delete-tool is-danger";
    commit.textContent = selection.size ? `删除选中 ${selection.size}` : "删除选中";
    commit.disabled = !selection.size;
    commit.addEventListener("click", () => deleteSelectedShortVideos().catch(showError));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "short-video-delete-tool";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      clearShortVideoDeleteSelection();
      refreshShortVideoDeleteSelectionUi();
    });
    wrap.append(selectLoaded, commit, cancel);
    return wrap;
  }

  function renderFollowingAuthorControls() {
    const wrap = document.createElement("div");
    wrap.className = "short-video-delete-actions short-video-following-controls";
    const label = document.createElement("label");
    label.className = "short-video-sort-control";
    const text = document.createElement("span");
    text.textContent = "排序";
    const select = document.createElement("select");
    select.className = "short-video-sort-select";
    select.setAttribute("aria-label", "我的关注排序");
    for (const item of [
      ["followed", "最近关注"],
      ["count", "视频数量"],
      ["liked", "喜欢视频数"]
    ]) {
      const option = document.createElement("option");
      option.value = item[0];
      option.textContent = item[1];
      select.append(option);
    }
    select.value = normalizeShortVideoAuthorSort(state.shortVideo.authorSort);
    select.addEventListener("change", () => {
      const nextSort = normalizeShortVideoAuthorSort(select.value);
      if (nextSort === state.shortVideo.authorSort) return;
      state.shortVideo.authorSort = nextSort;
      reloadFollowingAuthors();
    });
    label.append(text, select);

    const unlikedOnly = state.shortVideo.authorFilter === "unliked";
    const filter = document.createElement("button");
    filter.type = "button";
    filter.className = "short-video-delete-tool short-video-following-unliked";
    filter.classList.toggle("is-active", unlikedOnly);
    filter.setAttribute("aria-pressed", String(unlikedOnly));
    filter.textContent = `只看未点赞 ${formatNumber(state.shortVideo.authorUnlikedTotal || 0)}`;
    filter.addEventListener("click", () => {
      state.shortVideo.authorFilter = unlikedOnly ? "all" : "unliked";
      reloadFollowingAuthors();
    });
    wrap.append(label, filter);
    return wrap;
  }

  function reloadFollowingAuthors() {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    loadVideos({ skipRoute: true }).catch(showError);
  }

  function shortVideoDeleteSelection() {
    ensureState();
    return state.shortVideo.deleteSelection;
  }

  function clearShortVideoDeleteSelection(options = {}) {
    const selection = shortVideoDeleteSelection();
    selection.clear();
    if (!options.keepMode) state.shortVideo.deleteMode = false;
  }
  function refreshShortVideoDeleteSelectionUi() { const actions = els.workGrid?.querySelector?.(".short-video-delete-actions"); if (actions) actions.replaceWith(renderDeleteSelectionActions(state.shortVideo.data || {})); shortVideoListCards?.syncRenderedSelection?.(els.workGrid); }
  function toggleShortVideoSelected(id) {
    const videoId = String(id || "").trim();
    if (!videoId) return;
    const selection = shortVideoDeleteSelection();
    if (selection.has(videoId)) selection.delete(videoId);
    else selection.add(videoId);
    refreshShortVideoDeleteSelectionUi();
  }

  function toggleLoadedShortVideoSelection(loadedIds, clear) {
    const selection = shortVideoDeleteSelection();
    for (const id of loadedIds || []) {
      const videoId = String(id || "").trim();
      if (!videoId) continue;
      if (clear) selection.delete(videoId);
      else selection.add(videoId);
    }
    refreshShortVideoDeleteSelectionUi();
  }

  function shortVideoCardCoverUrl(video = {}) {
    return video.coverUrl || "";
  }

  function shortVideosWithCovers(videos = []) {
    return (videos || []).filter((video) => shortVideoCardCoverUrl(video));
  }

  function isGalleryPost(video = {}) {
    return String(video.mediaType || "").toLowerCase() === "gallery" && galleryImageEntries(video).length > 0;
  }

  function galleryImageEntries(video = {}) {
    if (Array.isArray(video.galleryItems) && video.galleryItems.length) {
      return video.galleryItems
        .filter((item) => item && item.url)
        .map((item) => ({ ...item, type: item.type === "video" ? "video" : "image" }));
    }
    return Array.isArray(video.galleryImages)
      ? video.galleryImages.filter((item) => item && item.url).map((item) => ({ ...item, type: "image" }))
      : [];
  }

  function galleryLabel(video = {}) {
    const count = Number(video.galleryCount || galleryImageEntries(video).length || 0);
    const hasVideo = galleryImageEntries(video).some((item) => item.type === "video");
    return `${Math.max(1, count)} ${hasVideo ? "项" : "张"}`;
  }

  function galleryBadge(video = {}) {
    const badge = document.createElement("span");
    badge.className = "short-video-gallery-badge";
    badge.append(createIcon("images"), document.createTextNode(galleryLabel(video)));
    return badge;
  }

  function cardTitle(video = {}) {
    return String(video.title || video.description || video.fileName || "无标题").replace(/\s+/g, " ").trim() || "无标题";
  }

  function renderBrowserTop() {
    const top = document.createElement("div");
    top.className = "short-video-browser-top";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "short-video-close";
    back.setAttribute("aria-label", "返回短视频列表");
    back.append(createIcon("chevronLeft"));
    back.addEventListener("click", showHome);
    const search = document.createElement("button");
    search.type = "button";
    search.className = "short-video-browser-search";
    search.setAttribute("aria-label", "返回列表搜索短视频");
    search.append(createIcon("search"));
    search.setAttribute("aria-label", "在当前视频上打开短视频搜索");
    const searchText = document.createElement("span");
    searchText.className = "short-video-browser-search-text";
    searchText.textContent = shortVideoSearch.label();
    const searchAction = document.createElement("span");
    searchAction.className = "short-video-browser-search-action";
    searchAction.textContent = "搜索";
    search.append(searchText, searchAction);
    search.addEventListener("click", (event) => showShortVideoSearchOverlay(event.currentTarget));
    top.append(back, search);
    return top;
  }

  function renderBrowserLoading() {
    const page = document.createElement("section");
    page.className = `short-video-browser is-loading-shell${shortVideoOpenError ? " is-load-error" : ""}`;
    const stage = document.createElement("div");
    stage.className = "short-video-loading-stage";
    const shimmer = document.createElement("span");
    shimmer.className = "short-video-loading-shimmer";
    shimmer.setAttribute("aria-hidden", "true");
    const status = document.createElement("div");
    status.className = "short-video-opening-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const icon = createIcon("repeat");
    icon.classList.add("short-video-opening-icon");
    const title = document.createElement("strong");
    title.textContent = shortVideoOpenError ? "作品暂时打不开" : "正在准备作品";
    const detail = document.createElement("span");
    detail.className = "short-video-opening-detail";
    detail.textContent = shortVideoOpenError || "正在读取本地媒体";
    status.append(icon, title, detail);
    if (shortVideoOpenError) {
      const actions = document.createElement("div");
      actions.className = "short-video-opening-actions";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载";
      retry.addEventListener("click", () => openVideo(shortVideoOpeningId).catch(showError));
      const back = document.createElement("button");
      back.type = "button";
      back.textContent = "返回列表";
      back.addEventListener("click", showHome);
      actions.append(retry, back);
      status.append(actions);
    }
    stage.append(shimmer, status);
    const controls = document.createElement("div");
    controls.className = "short-video-loading-controls";
    controls.setAttribute("aria-hidden", "true");
    controls.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    page.append(renderBrowserTop(), stage, controls);
    els.workGrid.append(page);
  }

  function renderBrowser() {
    const video = state.shortVideo.current;
    const page = document.createElement("section");
    page.className = "short-video-browser";
    page.classList.toggle("is-smart-fill", Boolean(state.shortVideo.smartFill));
    const slideDirection = Number(state.shortVideo.slideDirection || 0);
    if (slideDirection > 0) page.classList.add("is-slide-next");
    else if (slideDirection < 0) page.classList.add("is-slide-prev");
    if (slideDirection) {
      page.addEventListener("animationend", () => {
        if (state.shortVideo) state.shortVideo.slideDirection = 0;
      }, { once: true });
    }
    const top = renderBrowserTop();

    const stack = document.createElement("div");
    stack.className = "short-video-reel-stack";
    if (state.shortVideo.dragging) stack.classList.add("is-dragging");
    if (state.shortVideo.prevVideo) {
      stack.append(renderReelPanel(state.shortVideo.prevVideo, { ghost: true, slot: "prev" }).panel);
    }
    const current = renderReelPanel(video, { slot: "current" });
    const { player, syncPlayToggle } = current;
    stack.append(current.panel);
    if (state.shortVideo.nextVideo) {
      stack.append(renderReelPanel(state.shortVideo.nextVideo, { ghost: true, slot: "next" }).panel);
    }
    page.append(top, stack, renderBrowserNav(), isGalleryPost(video) ? renderGalleryControlBar(video) : renderControlBar());
    els.workGrid.append(page);
    syncPlayToggle();
    bindBrowserControlVisibility(page, player);
    if (!player) return;
    window.requestAnimationFrame(() => {
      player.play().then(syncPlayToggle).catch(() => {
        if (state.shortVideo.muted) {
          player.muted = true;
          player.play().then(syncPlayToggle).catch(syncPlayToggle);
          return;
        }
        markPlayerSoundBlocked(player.closest(".short-video-stage"));
        player.muted = true;
        player.play().then(syncPlayToggle).catch(syncPlayToggle);
        syncPlayToggle();
      });
    });
  }

  function renderReelPanel(video, options = {}) {
    const ghost = Boolean(options.ghost);
    const slot = options.slot || "current";
    const panel = document.createElement("div");
    panel.className = `short-video-reel-panel is-${slot}${ghost ? " is-ghost-panel" : ""}`;
    panel.dataset.videoId = String(video?.id || "");
    setReelPanelInteractionState(panel, !ghost);

    const gallery = isGalleryPost(video);
    panel.classList.toggle("is-gallery-post", gallery);
    const staticBackdropUrl = video.coverUrl || (gallery
      ? galleryImageEntries(video).find((item) => item.type !== "video")?.url || ""
      : "");
    const backdrop = document.createElement(staticBackdropUrl ? "img" : "div");
    backdrop.className = "short-video-backdrop-video";
    if (staticBackdropUrl) {
      backdrop.classList.add("short-video-backdrop-image");
      backdrop.decoding = "async";
      backdrop.loading = ghost ? "lazy" : "eager";
      backdrop.fetchPriority = ghost ? "low" : "high";
      backdrop.src = staticBackdropUrl;
      backdrop.alt = "";
      backdrop.setAttribute("aria-hidden", "true");
    } else {
      backdrop.classList.add("is-empty");
      backdrop.setAttribute("aria-hidden", "true");
    }

    const stage = document.createElement("div");
    stage.className = gallery ? "short-video-stage is-gallery-stage is-video-ready" : "short-video-stage is-video-loading";
    stage.setAttribute("aria-busy", String(!gallery));
    stage.tabIndex = -1;
    stage.addEventListener("pointerdown", (event) => {
      if (isShortVideoKeyboardControl(event.target)) return;
      stage.focus({ preventScroll: true });
    });
    applyVideoOrientation(panel, stage, video.width, video.height);
    if (video.coverUrl) {
      stage.style.setProperty("--short-video-cover", `url(${JSON.stringify(video.coverUrl)})`);
    }
    let firstFramePoster = null;
    if (!gallery && video.coverUrl) {
      firstFramePoster = document.createElement("img");
      firstFramePoster.className = "short-video-first-frame-poster";
      firstFramePoster.src = video.coverUrl;
      firstFramePoster.alt = "";
      firstFramePoster.decoding = "async";
      firstFramePoster.loading = ghost ? "lazy" : "eager";
      firstFramePoster.setAttribute("aria-hidden", "true");
      stage.append(firstFramePoster);
    }
    let player = null;
    let syncPlayToggle = () => {};
    if (gallery) {
      stage.append(renderGalleryPlayer(video, { ghost, stage, railGetter: () => rail }));
    } else {
      player = ghost ? null : takePrewarmedShortVideoPlayer(video);
      const reusedPrewarmedPlayer = Boolean(player);
      if (!player) player = document.createElement("video");
      player.className = "short-video-player";
      if (ghost) player.classList.add("is-ghost");
      player.removeAttribute("aria-hidden");
      player.removeAttribute("tabindex");
      // Loading policy must be applied before src. Setting src first lets the
      // browser start both off-screen reels with its default `auto` preload,
      // which can compete with the current video's first range request.
      player.preload = ghost ? "none" : "auto";
      player.fetchPriority = ghost ? "low" : "high";
      player.setAttribute("fetchpriority", ghost ? "low" : "high");
      playbackRenditionPolicy.preparePlayer(player, video);
      const playbackUrl = shortVideoPlaybackUrl(video);
      ensureShortVideoPlayerSource(player, video, {
        source: playbackUrl,
        forceReload: player.dataset.streamUrl !== playbackUrl,
        reason: ghost ? "render-adjacent" : "render-current"
      });
      player.dataset.videoId = String(video?.id || "");
      player.dataset.shortVideoSlot = slot;
      player.dataset.shortVideoAttachedAt = String(Date.now());
      if (video.coverUrl) player.poster = video.coverUrl;
      player.controls = false;
      player.autoplay = !ghost;
      player.muted = ghost ? true : Boolean(state.shortVideo.muted);
      player.volume = currentShortVideoVolume();
      player.playbackRate = normalizePlaybackRate(state.shortVideo.playbackRate);
      player.playsInline = true;
      player.loop = true;
      let firstFramePromise = null;
      let firstFrameAttempts = 0;
      let firstFrameRetryTimer = 0;
      const mediaEvents = new Set();
      const markMediaEvent = (eventName) => {
        if (mediaEvents.has(eventName)) return;
        mediaEvents.add(eventName);
        markShortVideoPerformance(`video-${eventName}`, {
          videoId: String(video?.id || ""),
          slot: String(player.dataset.shortVideoSlot || slot),
          ghost: player.classList.contains("is-ghost"),
          readyState: Number(player.readyState || 0),
          networkState: Number(player.networkState || 0),
          currentTime: Number(player.currentTime || 0),
          prewarmed: reusedPrewarmedPlayer
        });
      };
      markShortVideoPerformance("video-player-attached", {
        videoId: String(video?.id || ""),
        slot,
        ghost,
        prewarmed: reusedPrewarmedPlayer,
        readyState: Number(player.readyState || 0)
      });
      const revealVideoFrame = () => {
        stage.classList.remove("is-video-loading", "is-video-buffering", "is-video-error");
        stage.classList.add("is-video-ready");
        stage.setAttribute("aria-busy", "false");
        if (!player.dataset.shortVideoMediaReadyAt) player.dataset.shortVideoMediaReadyAt = String(Date.now());
        markShortVideoPerformance("video-first-frame-revealed", {
          videoId: String(video?.id || ""),
          slot: String(player.dataset.shortVideoSlot || slot),
          ghost: player.classList.contains("is-ghost"),
          readyState: Number(player.readyState || 0),
          currentTime: Number(player.currentTime || 0),
          prewarmed: reusedPrewarmedPlayer,
          attempts: firstFrameAttempts,
          attachedDurationMs: Date.now() - Number(player.dataset.shortVideoAttachedAt || Date.now())
        });
        if (!player.classList.contains("is-ghost") && isCurrentShortVideo(video)) {
          scheduleShortVideoPlaybackSettingsWarmup();
        }
        applyVideoOrientation(panel, stage, player.videoWidth, player.videoHeight);
      };
      const markVideoReady = () => {
        if (stage.classList.contains("is-video-ready") || firstFramePromise) return;
        firstFrameAttempts += 1;
        firstFramePromise = waitForVideoFirstFrame(player, ghost ? 1200 : SHORT_VIDEO_FIRST_FRAME_TIMEOUT_MS).then((ready) => {
          firstFramePromise = null;
          if (!player.isConnected || stage.classList.contains("is-video-ready")) return;
          if (!ready) {
            if (!player.requestVideoFrameCallback && player.readyState >= 2) {
              revealVideoFrame();
              return;
            }
            if (!player.error && firstFrameAttempts < SHORT_VIDEO_FIRST_FRAME_RETRY_LIMIT) {
              window.clearTimeout(firstFrameRetryTimer);
              firstFrameRetryTimer = window.setTimeout(markVideoReady, 120);
            }
            return;
          }
          revealVideoFrame();
        });
      };
      player.addEventListener("loadedmetadata", () => {
        markMediaEvent("loadedmetadata");
        applyVideoOrientation(panel, stage, player.videoWidth, player.videoHeight);
      });
      player.addEventListener("loadeddata", () => {
        markMediaEvent("loadeddata");
        markVideoReady();
      });
      player.addEventListener("canplay", () => {
        markMediaEvent("canplay");
        markVideoReady();
      });
      player.addEventListener("playing", () => {
        markMediaEvent("playing");
        markVideoReady();
      });
      window.requestAnimationFrame(() => {
        if (player.readyState >= 2) markVideoReady();
      });
      if (ghost) {
        stage.append(player);
        scheduleAdjacentVideoWarmup(player, video, slot);
      } else {
        syncPlayToggle = attachPrimaryPlayerControls(stage, player, () => rail, video);
      }
    }

    const info = document.createElement("div");
    info.className = "short-video-caption";
    const author = authorCaptionButton(video);
    const captionCopy = document.createElement("div");
    captionCopy.className = "short-video-caption-copy";
    const title = document.createElement("p");
    appendCaptionText(title, captionTitleWithTags(video), video);
    captionCopy.append(title);
    info.append(author, captionCopy);
    panel.append(backdrop, stage, info);

    const rail = document.createElement("aside");
    rail.className = "short-video-rail";
    const aiButton = railButton("识别", createIcon("ai"), "ai", "识别当前内容", () => showAuthorPanel(video, {
      initialTab: "ai",
      switchAuthorFeed: false
    }).catch(showError));
    rail.append(authorRailButton(video));
    const likeButton = railMetric("heart", video.stats?.likes, "like", "点赞");
    likeButton.dataset.videoId = String(video.id || "");
    likeButton.dataset.actionType = "like";
    likeButton.dataset.boundPrimaryLike = "1";
    likeButton.addEventListener("click", (event) => {
      toggleShortVideoAction(video, "like", likeButton);
      showHeartBurst(stage, event);
    });
    applyRailActionButtonState(likeButton, "like", Boolean(video.actions?.liked), video.stats?.likes);
    rail.append(likeButton);
    rail.append(railMetric("comment", video.stats?.comments, "comment", "评论", () => showAuthorPanel(video, {
      initialTab: "comments",
      switchAuthorFeed: false
    })));
    const collectButton = railMetric("star", video.stats?.collects, "collect", "收藏");
    collectButton.dataset.videoId = String(video.id || "");
    collectButton.dataset.actionType = "collect";
    collectButton.addEventListener("click", () => toggleShortVideoAction(video, "collect", collectButton));
    applyRailActionButtonState(collectButton, "collect", Boolean(video.actions?.collected), video.stats?.collects);
    rail.append(collectButton);
    rail.append(railButton("清单", createIcon("plusBadge"), "collection", "加入清单", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      collectionsController.showPicker(video).catch((error) => showBrowserToast(error?.message || "清单读取失败"));
    }));
    rail.append(railMetric("share", video.stats?.shares, "share", "分享", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      shareShortVideo(video, { trigger: event?.currentTarget || null });
    }));
    const soundVisual = video.sound?.coverUrl
      ? Object.assign(document.createElement("img"), {
        className: "short-video-sound-rail-cover",
        src: video.sound.coverUrl,
        alt: ""
      })
      : createIcon("headphones");
    const listenButton = railButton(video.sound ? "原声" : "听抖音", soundVisual, "listen", video.sound ? `原声：${video.sound.title}` : "听抖音", () => {
      if (!video.sound) {
        openDouyinLink(video);
        return;
      }
      showAuthorPanel(video, { initialTab: "sound", switchAuthorFeed: false }).catch(showError);
    });
    rail.append(listenButton);
    rail.append(aiButton);
    rail.append(railButton("", createIcon("more"), "more", "更多", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showPlaybackSettings(video, { trigger: event.currentTarget });
    }));
    panel.append(rail);

    return { panel, player, syncPlayToggle };
  }

  function setReelPanelInteractionState(panel, interactive) {
    if (!panel) return;
    panel.inert = !interactive;
    if (interactive) panel.removeAttribute("aria-hidden");
    else panel.setAttribute("aria-hidden", "true");
  }

  function ensureShortVideoGalleryPlayer() {
    if (shortVideoGalleryPlayerPromise) return shortVideoGalleryPlayerPromise;
    markShortVideoPerformance("gallery-player-module-start");
    const moduleUrl = "/modules/short-videos/gallery-player.js?v=20260727-live-photo-15";
    shortVideoGalleryPlayerPromise = import(moduleUrl).then((module) => {
      if (typeof module.createShortVideoGalleryPlayer !== "function") {
        throw new Error("图文播放器模块加载失败");
      }
      const render = module.createShortVideoGalleryPlayer({
        api,
        applyVideoOrientation,
        clearPlayerSoundBlocked,
        createIcon,
        currentShortVideoVolume,
        els,
        formatBytes,
        galleryImageEntries,
        handleGalleryAutoNext,
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
      });
      markShortVideoPerformance("gallery-player-module-ready");
      return render;
    }).catch((error) => {
      shortVideoGalleryPlayerPromise = null;
      markShortVideoPerformance("gallery-player-module-error", {
        message: String(error?.message || error || "unknown")
      });
      throw error;
    });
    return shortVideoGalleryPlayerPromise;
  }

  function renderGalleryPlayer(video, options = {}) {
    const ghost = Boolean(options.ghost);
    const stage = options.stage;
    const placeholder = document.createElement("div");
    placeholder.className = `short-video-gallery-player is-loading${ghost ? " is-ghost" : ""}`;
    placeholder.setAttribute("role", "group");
    placeholder.setAttribute("aria-label", ghost ? "图文播放器预览" : "正在加载图文播放器");
    placeholder.setAttribute("aria-busy", String(!ghost));
    placeholder.dataset.galleryIndex = "0";
    placeholder.dataset.galleryRequestedIndex = "0";
    placeholder.dataset.galleryCount = "0";

    if (ghost) return placeholder;

    const status = document.createElement("div");
    status.className = "short-video-gallery-load-status is-visible";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = "正在载入图文播放器…";
    placeholder.append(status);
    stage?.setAttribute("aria-busy", "true");
    const startedAt = Date.now();

    ensureShortVideoGalleryPlayer().then((render) => {
      if (!placeholder.isConnected) return;
      const player = render(video, options);
      placeholder.replaceWith(player);
      stage?.setAttribute("aria-busy", "false");
      markShortVideoPerformance("gallery-player-mounted", {
        videoId: String(video?.id || ""),
        durationMs: Date.now() - startedAt
      });
      if (isCurrentShortVideo(video)) syncActiveControlBar();
    }).catch((error) => {
      if (!placeholder.isConnected) return;
      placeholder.classList.remove("is-loading");
      placeholder.classList.add("is-error");
      placeholder.setAttribute("aria-busy", "false");
      stage?.setAttribute("aria-busy", "false");
      status.classList.add("is-error");
      status.textContent = error?.message || "图文播放器加载失败";
      showBrowserToast(status.textContent);
    });

    return placeholder;
  }

  function applyVideoOrientation(panel, stage, width, height) {
    const w = Number(width || 0);
    const h = Number(height || 0);
    if (!panel || !stage || !w || !h) return;
    const landscape = w / h >= 1.08;
    panel.classList.toggle("is-landscape-video", landscape);
    panel.classList.toggle("is-portrait-video", !landscape);
    stage.classList.toggle("is-landscape-video", landscape);
    stage.classList.toggle("is-portrait-video", !landscape);
  }

  function renderBrowserNav() {
    const nav = document.createElement("div");
    nav.className = "short-video-nav-pair";
    const prev = railNav("↑", () => openAdjacent(-1), !state.shortVideo.prevId);
    const next = railNav("↓", () => openAdjacent(1), !state.shortVideo.nextId);
    nav.append(prev, next);
    return nav;
  }

  function bindShortVideoPlaybackStatus(stage, player, video, syncPlayToggle = () => {}) {
    if (!stage || !player || player.dataset.playbackStatusBound === "1") return;
    player.dataset.playbackStatusBound = "1";

    const status = document.createElement("div");
    status.className = "short-video-playback-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-hidden", "true");
    const statusIcon = createIcon("repeat");
    statusIcon.classList.add("short-video-playback-status-icon");
    const copy = document.createElement("span");
    copy.className = "short-video-playback-status-copy";
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    copy.append(title, detail);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "short-video-playback-retry";
    retry.append(createIcon("repeat"), document.createTextNode("重新加载"));
    status.append(statusIcon, copy, retry);
    stage.append(status);

    let feedbackTimer = 0;
    let stuckTimer = 0;
    let retrying = false;
    let automaticSourceRecoveryAttempted = false;
    let wantsToPlay = Boolean(player.autoplay);
    let lastGoodTime = Math.max(0, Number(player.currentTime || 0));

    const clearTimers = () => {
      window.clearTimeout(feedbackTimer);
      window.clearTimeout(stuckTimer);
      feedbackTimer = 0;
      stuckTimer = 0;
    };
    const syncStageState = (kind) => {
      stage.classList.toggle("is-video-loading", kind === "loading" || kind === "retrying");
      stage.classList.toggle("is-video-buffering", kind === "buffering");
      stage.classList.toggle("is-video-error", kind === "error");
      if (kind === "loading" || kind === "retrying") stage.classList.remove("is-video-ready");
      stage.setAttribute("aria-busy", String(kind === "loading" || kind === "buffering" || kind === "retrying"));
      syncPlayToggle();
    };
    const showStatus = (kind, heading, message) => {
      clearTimers();
      status.dataset.state = kind;
      title.textContent = heading;
      detail.textContent = message;
      status.classList.add("is-visible");
      status.setAttribute("aria-hidden", "false");
      syncStageState(kind);
      if (kind === "loading" || kind === "buffering" || kind === "retrying") {
        stuckTimer = window.setTimeout(() => {
          if (player.readyState >= 2 && !stage.classList.contains("is-video-buffering")) return;
          const issueReason = player.currentTime > 0.05 ? "playback-stalled" : "first-frame-timeout";
          if (switchToSmoothFallback(issueReason)) return;
          const boundSource = String(player.currentSrc || player.getAttribute("src") || "").trim();
          if (
            !automaticSourceRecoveryAttempted
            && (player.dataset.shortVideoDecoderReleased === "1" || !boundSource)
          ) {
            automaticSourceRecoveryAttempted = true;
            const sourceRestored = ensureShortVideoPlayerSource(player, video, {
              forceReload: true,
              reason: "stuck-timeout"
            });
            if (sourceRestored) {
              retrying = true;
              showStatus("retrying", "正在重新加载", "已自动恢复视频地址");
              if (wantsToPlay) player.play?.().catch(() => {});
              return;
            }
          }
          retrying = false;
          showStatus("error", "视频加载失败", "保留当前进度后重试");
        }, 8000);
      }
    };
    const switchToSmoothFallback = (reason) => {
      const switched = playbackRenditionPolicy.switchToSmoothFallback(player, video, reason, {
        ensureSource: ensureShortVideoPlayerSource,
        lastGoodTime,
        wantsToPlay
      });
      if (!switched) return false;
      retrying = true;
      showStatus("retrying", "正在准备兼容播放", "只为这条实际卡住的视频生成流畅版");
      return true;
    };
    const hideStatus = () => {
      clearTimers();
      retrying = false;
      status.classList.remove("is-visible");
      status.removeAttribute("data-state");
      status.setAttribute("aria-hidden", "true");
      stage.classList.remove("is-video-buffering", "is-video-error");
      if (player.readyState >= 2 && player.dataset.shortVideoFrameReady === "1") {
        stage.classList.remove("is-video-loading");
        stage.classList.add("is-video-ready");
        stage.setAttribute("aria-busy", "false");
      }
      syncPlayToggle();
    };
    const showDelayed = (kind) => {
      window.clearTimeout(feedbackTimer);
      feedbackTimer = window.setTimeout(() => {
        if (kind === "loading" && player.readyState >= 2) return;
        if (kind === "buffering" && (!wantsToPlay || player.readyState >= 3)) return;
        if (kind === "loading") showStatus("loading", "正在加载视频", "即将开始播放");
        else showStatus("buffering", "正在缓冲", "网络恢复后会自动继续");
      }, 420);
    };
    const handleLoadStart = () => {
      stage.classList.add("is-video-loading");
      stage.classList.remove("is-video-ready", "is-video-error");
      showDelayed("loading");
      syncPlayToggle();
    };
    const handleWaiting = () => {
      if (!wantsToPlay && player.currentTime > 0) return;
      showDelayed(player.readyState >= 2 ? "buffering" : "loading");
    };
    const handleReady = () => {
      if (player.readyState < 2) return;
      automaticSourceRecoveryAttempted = false;
      const recoveredFromRetry = retrying;
      hideStatus();
      if (recoveredFromRetry) warmVisibleAdjacentVideoPlayers();
    };
    const handleError = () => {
      if ([3, 4].includes(Number(player.error?.code || 0)) && switchToSmoothFallback("decode-error")) return;
      if (playbackRenditionPolicy.retrySmoothFallback(player, video, {
        ensureSource: ensureShortVideoPlayerSource,
        lastGoodTime,
        wantsToPlay,
        onScheduled: (attempt, limit) => {
          retrying = true; showStatus("retrying", "兼容版本正在生成", `自动重试 ${attempt}/${limit}`);
        }
      })) return;
      retrying = false;
      showStatus("error", "视频加载失败", "保留当前进度后重试");
    };
    const rememberProgress = () => {
      // A failed source reset emits timeupdate with currentTime = 0 and
      // readyState = HAVE_NOTHING. Do not let that erase the last playable
      // position that the retry flow promises to restore.
      if (player.error || player.readyState < 2) return;
      const current = Math.max(0, Number(player.currentTime || 0));
      if (!Number.isFinite(current)) return;
      const madeForwardProgress = current > lastGoodTime + 0.04;
      lastGoodTime = current;
      // Some media stacks resume advancing without another canplay/playing
      // event. Progress itself is the strongest recovery signal.
      if (madeForwardProgress && wantsToPlay && status.dataset.state === "buffering") hideStatus();
    };

    player.addEventListener("loadstart", handleLoadStart);
    player.addEventListener("waiting", handleWaiting);
    player.addEventListener("stalled", handleWaiting);
    player.addEventListener("error", handleError);
    player.addEventListener("loadeddata", handleReady);
    player.addEventListener("canplay", handleReady);
    player.addEventListener("playing", () => {
      wantsToPlay = true;
      handleReady();
    });
    player.addEventListener("play", () => {
      wantsToPlay = true;
    });
    player.addEventListener("pause", () => {
      if (!retrying && !player.error && !stage.classList.contains("is-video-error")) wantsToPlay = false;
    });
    player.addEventListener("timeupdate", rememberProgress);
    player.addEventListener("seeked", rememberProgress);

    retry.addEventListener("pointerdown", (event) => event.stopPropagation());
    retry.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const source = String(player.dataset.streamUrl || shortVideoPlaybackUrl(video) || player.currentSrc || player.src || "").trim();
      if (!source) {
        showStatus("error", "视频加载失败", "暂时找不到可播放的视频地址");
        return;
      }
      const preservedTime = Math.max(lastGoodTime, Math.max(0, Number(player.currentTime || 0)));
      const preservedMuted = Boolean(player.muted);
      const preservedVolume = Math.max(0, Math.min(1, Number(player.volume || 0)));
      const preservedRate = normalizePlaybackRate(player.playbackRate);
      const shouldPlay = wantsToPlay || (!player.paused && !player.ended);
      retrying = true;
      wantsToPlay = shouldPlay;
      showStatus("retrying", "正在重新加载", "恢复播放状态中");

      const restorePlaybackState = () => {
        player.muted = preservedMuted;
        player.volume = preservedVolume;
        player.playbackRate = preservedRate;
        const duration = Math.max(0, Number(player.duration || 0));
        if (duration > 0 && preservedTime > 0) {
          try {
            player.currentTime = Math.min(preservedTime, Math.max(0, duration - 0.2));
          } catch {}
        }
        if (!shouldPlay) return;
        const resume = () => {
          player.play().catch(() => {
            if (!player.error) {
              wantsToPlay = false;
              handleReady();
            }
          });
        };
        if (player.readyState >= 2) resume();
        else player.addEventListener("canplay", resume, { once: true });
      };
      player.addEventListener("loadedmetadata", restorePlaybackState, { once: true });
      ensureShortVideoPlayerSource(player, video, {
        source,
        forceReload: true,
        reason: "manual-retry"
      });
    });

    if (player.error) handleError();
    else if (player.readyState >= 2) hideStatus();
    else showDelayed("loading");
  }

  function attachPrimaryPlayerControls(stage, player, railGetter, video = state.shortVideo?.current, options = {}) {
    const centerPlay = document.createElement("button");
    centerPlay.type = "button";
    centerPlay.className = "short-video-center-play";
    centerPlay.tabIndex = -1;
    centerPlay.setAttribute("aria-hidden", "true");
    setIconButton(centerPlay, "play", "继续播放当前视频");
    const syncPlayToggle = () => {
      const paused = Boolean(player.paused);
      const centerVisible = paused
        && player.readyState >= 2
        && !stage.classList.contains("is-video-loading")
        && !stage.classList.contains("is-video-buffering")
        && !stage.classList.contains("is-video-error");
      stage.classList.toggle("is-paused", paused);
      centerPlay.classList.toggle("is-visible", centerVisible);
      centerPlay.tabIndex = centerVisible ? 0 : -1;
      centerPlay.setAttribute("aria-hidden", String(!centerVisible));
    };
    centerPlay.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!player.paused) return;
      player.play().then(() => {
        syncPlayToggle();
        stage.focus({ preventScroll: true });
      }).catch(syncPlayToggle);
    });
    centerPlay.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearPendingPlayerClick();
      toggleShortVideoAction(state.shortVideo?.current, "like", railGetter?.(), { forceActive: true, silent: true });
      showHeartBurst(stage, event);
    });
    if (player.dataset.primaryControlsBound !== "1") {
      const togglePlay = () => {
        if (player.paused) {
          player.play().then(syncPlayToggle).catch(syncPlayToggle);
        } else {
          player.pause();
          syncPlayToggle();
        }
      };
      player.dataset.primaryControlsBound = "1";
      const syncGlobalControlBar = () => {
        if (player === activePlayer()) syncActiveControlBar();
      };
      player.addEventListener("play", syncPlayToggle);
      player.addEventListener("play", syncGlobalControlBar);
      player.addEventListener("play", () => {
        if (!player.muted) clearPlayerSoundBlocked(stage);
      });
      player.addEventListener("pause", syncPlayToggle);
      player.addEventListener("pause", syncGlobalControlBar);
      player.addEventListener("loadedmetadata", syncPlayToggle);
      player.addEventListener("loadedmetadata", syncGlobalControlBar);
      player.addEventListener("ratechange", syncGlobalControlBar);
      player.addEventListener("volumechange", syncGlobalControlBar);
      player.addEventListener("ended", () => handleAutoNextEnded(player));
      bindHoldToSpeed(stage, player);
      player.addEventListener("click", (event) => {
        if (suppressNextPlayerClick) {
          clearPendingPlayerClick();
          suppressNextPlayerClick = false;
          return;
        }
        if (revealShortVideoClearScreen(stage) || wasClearScreenJustRevealed(stage)) {
          clearPendingPlayerClick();
          return;
        }
        if (isShortVideoGestureClickBlocked(stage)) {
          clearPendingPlayerClick();
          return;
        }
        if (stage.classList.contains("is-sound-blocked")) {
          event.preventDefault();
          clearPendingPlayerClick();
          restorePlayerSound(player, stage);
          return;
        }
        if (pendingPlayerTap?.player === player) {
          window.clearTimeout(playerClickTimer);
          playerClickTimer = 0;
          return;
        }
        clearPendingPlayerClick();
        const tapToken = String(Date.now());
        pendingPlayerTap = {
          player,
          wasPlaying: Boolean(!player.paused && !player.ended),
          token: tapToken
        };
        player.dataset.shortVideoTapToken = tapToken;
        player.dataset.shortVideoTapWasPlaying = pendingPlayerTap.wasPlaying ? "1" : "0";
        togglePlay();
        playerClickTimer = window.setTimeout(() => {
          if (pendingPlayerTap?.player === player && pendingPlayerTap.token === tapToken) {
            clearPendingPlayerClick();
          }
        }, SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS);
      });
      stage.addEventListener("dblclick", (event) => {
        if (wasClearScreenJustRevealed(stage) || isShortVideoGestureClickBlocked(stage)) {
          clearPendingPlayerClick();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const tapWasPlaying = player.dataset.shortVideoTapWasPlaying;
        clearPendingPlayerClick();
        if (tapWasPlaying === "1" && player.paused) {
          player.play().then(syncPlayToggle).catch(syncPlayToggle);
        } else if (tapWasPlaying === "0") {
          const pauseGuard = String(Date.now());
          player.dataset.shortVideoTapPauseGuard = pauseGuard;
          const enforcePausedTapState = () => {
            if (player.dataset.shortVideoTapPauseGuard !== pauseGuard) return;
            player.pause();
            syncPlayToggle();
          };
          player.addEventListener("play", enforcePausedTapState);
          enforcePausedTapState();
          window.setTimeout(() => {
            player.removeEventListener("play", enforcePausedTapState);
            if (player.dataset.shortVideoTapPauseGuard === pauseGuard) {
              delete player.dataset.shortVideoTapPauseGuard;
            }
          }, 240);
        }
        toggleShortVideoAction(state.shortVideo?.current, "like", railGetter?.(), { forceActive: true, silent: true });
        showHeartBurst(stage, event);
      });
    }
    bindShortVideoWatchTracking(stage, player, video, { resume: options.resume !== false });
    stage.append(player, centerPlay);
    bindShortVideoPlaybackStatus(stage, player, video, syncPlayToggle);
    syncActivePlaybackMode(player);
    syncPlayToggle();
    return syncPlayToggle;
  }

  function clearPendingPlayerClick() {
    const tap = pendingPlayerTap;
    window.clearTimeout(playerClickTimer);
    playerClickTimer = 0;
    pendingPlayerTap = null;
    if (tap && tap.player?.dataset?.shortVideoTapToken === tap.token) {
      delete tap.player.dataset.shortVideoTapToken;
      delete tap.player.dataset.shortVideoTapWasPlaying;
    }
  }

  function bindShortVideoWatchTracking(stage, player, video, options = {}) {
    const videoId = String(video?.id || "").trim();
    if (!videoId || player.dataset.watchTrackingVideoId === videoId) return;
    player.dataset.watchTrackingVideoId = videoId;
    const resumeProgressMs = Math.max(0, Number(video?.watch?.progressMs || 0));
    const resumeCompleted = Boolean(video?.watch?.completed);
    const restore = () => {
      if (player.dataset.watchRestored === "1") return;
      player.dataset.watchRestored = "1";
      player.dataset.watchRestoredAt = String(Date.now());
      const durationMs = Math.max(0, Number(player.duration || 0) * 1000);
      const canResume = options.resume !== false
        && !resumeCompleted
        && resumeProgressMs >= 1500
        && durationMs > 0
        && durationMs - resumeProgressMs >= 1500;
      if (canResume) {
        try {
          player.currentTime = resumeProgressMs / 1000;
          window.requestAnimationFrame(() => {
            if (stage.isConnected && player === activePlayer()) {
              showBrowserToast(`已续播至 ${formatSeconds(resumeProgressMs / 1000)}`);
            }
          });
        } catch {}
      }
      persistShortVideoWatch(video, player, { force: true });
    };
    const scheduleRestore = () => {
      if (player.dataset.watchRestored === "1" || player.dataset.watchRestoreScheduled === "1") return;
      const durationMs = Math.max(0, Number(player.duration || 0) * 1000);
      const canResume = options.resume !== false
        && !resumeCompleted
        && resumeProgressMs >= 1500
        && durationMs > 0
        && durationMs - resumeProgressMs >= 1500;
      if (!canResume) {
        restore();
        return;
      }
      player.dataset.watchRestoreScheduled = "1";
      waitForVideoFirstFrame(player, 1800).finally(() => {
        window.requestAnimationFrame(() => {
          if (player.isConnected) restore();
        });
      });
    };
    player.addEventListener("loadedmetadata", scheduleRestore, { once: true });
    player.addEventListener("playing", () => {
      if (player.dataset.watchRestored === "1") persistShortVideoWatch(video, player);
    });
    player.addEventListener("pause", () => {
      if (player.dataset.watchRestored === "1") persistShortVideoWatch(video, player, { force: true });
    });
    player.addEventListener("timeupdate", () => {
      if (player.dataset.watchRestored !== "1") return;
      const duration = Math.max(0, Number(player.duration || 0));
      const current = Math.max(0, Number(player.currentTime || 0));
      if (duration > 0 && duration - current <= 0.8) {
        if (player.dataset.watchCompleted !== "1") {
          player.dataset.watchCompleted = "1";
          persistShortVideoWatch(video, player, { force: true, completed: true });
        }
        return;
      }
      if (duration > 0 && current < duration * 0.5) player.dataset.watchCompleted = "";
      persistShortVideoWatch(video, player);
    });
    player.addEventListener("ended", () => persistShortVideoWatch(video, player, { force: true, completed: true }));
    if (player.readyState >= 1) window.requestAnimationFrame(scheduleRestore);
  }

  function persistShortVideoWatch(video, player, options = {}) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return;
    const now = Date.now();
    let write = shortVideoWatchWrites.get(videoId);
    if (!write) {
      write = { inFlight: false, lastSavedAt: 0, lastPayload: null, pending: null };
      shortVideoWatchWrites.set(videoId, write);
    } else {
      shortVideoWatchWrites.delete(videoId);
      shortVideoWatchWrites.set(videoId, write);
    }
    trimShortVideoWatchWrites(videoId);
    if (!options.force && now - write.lastSavedAt < SHORT_VIDEO_WATCH_SAVE_INTERVAL) return;
    const progressMs = Math.max(0, Math.round(Number(player?.currentTime || 0) * 1000));
    const payload = { progressMs, completed: Boolean(options.completed) };
    if (
      options.force
      && now - write.lastSavedAt < 600
      && write.lastPayload?.completed === payload.completed
      && Math.abs(Number(write.lastPayload?.progressMs || 0) - progressMs) < 1000
    ) {
      return;
    }
    write.lastSavedAt = now;
    write.lastPayload = payload;
    if (write.inFlight) {
      write.pending = mergeShortVideoWatchPayload(write.pending, payload);
      return;
    }
    dispatchShortVideoWatchWrite(video, write, payload);
  }

  function dispatchShortVideoWatchWrite(video, write, payload) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return;
    write.inFlight = true;
    api(`/api/short-videos/${encodeURIComponent(videoId)}/watch`, {
      method: "PUT",
      keepalive: true,
      body: payload
    }).then((data) => {
      if (data?.video) syncShortVideoWatchVideo(data.video);
      else if (data?.videoId && data?.watch) {
        syncShortVideoWatchVideo({ id: data.videoId, watch: data.watch });
      }
    }).catch((error) => {
      console.warn("观看进度保存失败", error);
    }).finally(() => {
      write.inFlight = false;
      const pending = write.pending;
      write.pending = null;
      if (pending) dispatchShortVideoWatchWrite(video, write, pending);
      else trimShortVideoWatchWrites();
    });
  }

  function bindBrowserControlVisibility(browser, player) {
    if (!browser || browser.dataset.controlsVisibilityBound === "1") return;
    browser.dataset.controlsVisibilityBound = "1";
    const finePointer = window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches !== false;
    let idleTimer = 0;
    let readinessTimer = 0;
    let lastPointerX = -1;
    let lastPointerY = -1;

    const clearIdleTimer = () => {
      window.clearTimeout(idleTimer);
      idleTimer = 0;
    };
    const clearReadinessTimer = () => {
      window.clearTimeout(readinessTimer);
      readinessTimer = 0;
    };
    const controlsPinned = () => {
      const currentPanel = browser.querySelector(".short-video-reel-panel.is-current");
      const currentPlayer = currentPanel?.querySelector(".short-video-gallery-audio, .short-video-player:not(.is-ghost)");
      const gallery = currentPanel?.querySelector(".short-video-gallery-player");
      const mediaNotReady = currentPlayer
        ? currentPlayer.readyState < 2
        : !gallery || gallery.classList.contains("is-image-loading");
      const playbackPaused = currentPlayer
        ? currentPlayer.paused
        : gallery?.dataset?.galleryPlaybackPaused === "1";
      const focused = document.activeElement;
      const hasInteractiveFocus = focused && browser.contains(focused) && isShortVideoKeyboardControl(focused);
      return mediaNotReady
        || playbackPaused
        || hasInteractiveFocus
        || browser.classList.contains("is-volume-open")
        || browser.classList.contains("is-author-panel-open")
        || Boolean(browser.querySelector(".short-video-search-overlay, .short-video-more-overlay, .short-video-share-panel"));
    };
    const hideControls = () => {
      idleTimer = 0;
      if (controlsPinned() || !browser.isConnected) return;
      browser.classList.add("is-controls-idle");
    };
    const revealControls = (delay = 1500) => {
      clearIdleTimer();
      browser.classList.remove("is-controls-idle");
      if (controlsPinned()) return;
      idleTimer = window.setTimeout(hideControls, Math.max(300, Number(delay || 0)));
    };
    const pinControls = () => {
      clearIdleTimer();
      browser.classList.remove("is-controls-idle");
    };
    const handlePointerMove = (event) => {
      const x = Number(event.clientX || 0);
      const y = Number(event.clientY || 0);
      if (lastPointerX >= 0 && Math.hypot(x - lastPointerX, y - lastPointerY) < 3) return;
      lastPointerX = x;
      lastPointerY = y;
      const nearControls = y >= Math.max(0, window.innerHeight - 88);
      revealControls(nearControls ? 2400 : 1500);
    };
    const handlePointerLeave = () => {
      if (finePointer) revealControls(520);
    };
    const handlePointerDown = (event) => {
      if (!finePointer
        && browser.classList.contains("is-controls-idle")
        && !isShortVideoKeyboardControl(event.target)) {
        browser.dataset.shortVideoTapReveal = "1";
        suppressNextPlayerClick = true;
        window.setTimeout(() => {
          if (browser.dataset.shortVideoTapReveal === "1") delete browser.dataset.shortVideoTapReveal;
          suppressNextPlayerClick = false;
        }, 520);
      }
      revealControls(finePointer ? 1900 : 2400);
    };
    const handleFocusIn = () => pinControls();
    const handleFocusOut = () => window.setTimeout(() => revealControls(1500));
    const isActiveMediaEvent = (event) => event.target === browser.querySelector(
      ".short-video-reel-panel.is-current .short-video-gallery-audio, .short-video-reel-panel.is-current .short-video-player:not(.is-ghost)"
    );
    const handlePlay = (event) => {
      if (isActiveMediaEvent(event)) revealControls(1700);
    };
    const handlePause = (event) => {
      if (isActiveMediaEvent(event)) pinControls();
    };
    const handleWaiting = (event) => {
      if (isActiveMediaEvent(event)) pinControls();
    };
    const handlePlaying = (event) => {
      if (isActiveMediaEvent(event)) revealControls(1500);
    };
    const revealWhenReady = (attempt = 0) => {
      clearReadinessTimer();
      if (!browser.isConnected) return;
      if (controlsPinned()) {
        if (attempt < 28) readinessTimer = window.setTimeout(() => revealWhenReady(attempt + 1), 220);
        return;
      }
      revealControls(finePointer ? 1500 : 2400);
    };

    browser.addEventListener("pointermove", handlePointerMove, { passive: true });
    browser.addEventListener("pointerleave", handlePointerLeave, { passive: true });
    browser.addEventListener("pointerdown", handlePointerDown, { passive: true });
    browser.addEventListener("focusin", handleFocusIn);
    browser.addEventListener("focusout", handleFocusOut);
    browser.addEventListener("play", handlePlay, true);
    browser.addEventListener("pause", handlePause, true);
    browser.addEventListener("waiting", handleWaiting, true);
    browser.addEventListener("playing", handlePlaying, true);

    browser.shortVideoRevealControls = revealControls;
    browser.shortVideoControlsDispose = () => {
      clearIdleTimer();
      clearReadinessTimer();
      browser.removeEventListener("pointermove", handlePointerMove);
      browser.removeEventListener("pointerleave", handlePointerLeave);
      browser.removeEventListener("pointerdown", handlePointerDown);
      browser.removeEventListener("focusin", handleFocusIn);
      browser.removeEventListener("focusout", handleFocusOut);
      browser.removeEventListener("play", handlePlay, true);
      browser.removeEventListener("pause", handlePause, true);
      browser.removeEventListener("waiting", handleWaiting, true);
      browser.removeEventListener("playing", handlePlaying, true);
    };
    revealControls(finePointer ? 1800 : 2600);
    readinessTimer = window.setTimeout(() => revealWhenReady(0), 220);
  }

  function syncShortVideoWatchVideo(updated) {
    if (!updated?.id) return;
    const candidates = [
      state.shortVideo?.current,
      state.shortVideo?.prevVideo,
      state.shortVideo?.nextVideo,
      ...(state.shortVideo?.data?.videos || [])
    ];
    for (const item of candidates) {
      if (!item || !isCurrentShortVideo(updated, item)) continue;
      item.watch = { ...(item.watch || {}), ...(updated.watch || {}) };
    }
  }

  function flushActiveShortVideoWatch() {
    const video = state.shortVideo?.current;
    if (!video?.id) return;
    if (isGalleryPost(video)) {
      persistShortVideoWatch(video, null, { force: true, completed: true });
      return;
    }
    persistShortVideoWatch(video, activePlayer(), { force: true });
  }

  function handleAutoNextEnded(player) {
    if (!state.shortVideo?.autoNext || els.workGrid?.querySelector?.(".short-video-more-overlay")) return;
    if (player !== activePlayer()) return;
    if (!state.shortVideo.nextId) {
      player.loop = true;
      player.currentTime = 0;
      player.play?.().catch(() => {});
      showBrowserToast("已经是最后一条");
      return;
    }
    openAdjacent(1).catch(showError);
  }

  function handleGalleryAutoNext(video) {
    if (!state.shortVideo?.autoNext || !isCurrentShortVideo(video)) return false;
    if (!state.shortVideo.nextId) {
      showBrowserToast("已经是最后一条");
      return false;
    }
    openAdjacent(1).catch(showError);
    return true;
  }

  function syncActivePlaybackMode(player = activePlayer()) {
    if (!player || player.classList.contains("is-ghost")) return;
    player.loop = !(state.shortVideo?.autoNext && state.shortVideo?.nextId);
    if (player.dataset.holdSpeedActive !== "1") {
      player.playbackRate = normalizePlaybackRate(state.shortVideo?.playbackRate);
    }
  }

  function bindHoldToSpeed(stage, player) {
    if (!stage || !player || player.dataset.holdSpeedBound === "1") return;
    player.dataset.holdSpeedBound = "1";
    let holdTimer = 0;
    let holdPointerId = null;
    let holdStartX = 0;
    let holdStartY = 0;
    let holdActive = false;
    let holdBaseRate = normalizePlaybackRate(state.shortVideo?.playbackRate);

    const clearHoldTimer = () => {
      window.clearTimeout(holdTimer);
      holdTimer = 0;
    };
    const setClickSuppression = () => {
      suppressNextPlayerClick = true;
      window.setTimeout(() => {
        suppressNextPlayerClick = false;
      }, 280);
    };
    const stopHold = (options = {}) => {
      clearHoldTimer();
      if (holdActive) {
        holdActive = false;
        delete player.dataset.holdSpeedActive;
        player.playbackRate = normalizePlaybackRate(state.shortVideo?.playbackRate);
        clearHoldSpeedFeedback(stage);
        if (options.suppressClick) setClickSuppression();
      }
      holdPointerId = null;
    };
    const startHold = () => {
      holdTimer = 0;
      if (holdPointerId == null || !player.isConnected || player.paused) return;
      holdActive = true;
      holdSpeedGestureConsumed = true;
      state.shortVideo.dragging = false;
      snapStackBack();
      holdBaseRate = normalizePlaybackRate(state.shortVideo?.playbackRate);
      player.dataset.holdSpeedActive = "1";
      player.playbackRate = 2;
      showHoldSpeedFeedback(stage, holdBaseRate);
    };
    const finishPointer = (event, options = {}) => {
      if (holdPointerId == null || (event?.pointerId != null && event.pointerId !== holdPointerId)) return;
      const wasActive = holdActive;
      stopHold({ suppressClick: wasActive && options.suppressClick !== false });
    };

    player.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false || player.paused) return;
      if (pendingPlayerTap?.player !== player) clearPendingPlayerClick();
      stopHold();
      holdPointerId = event.pointerId;
      holdStartX = Number(event.clientX || 0);
      holdStartY = Number(event.clientY || 0);
      holdTimer = window.setTimeout(startHold, 360);
    });
    player.addEventListener("pointermove", (event) => {
      if (holdPointerId == null || event.pointerId !== holdPointerId) return;
      const deltaX = Number(event.clientX || 0) - holdStartX;
      const deltaY = Number(event.clientY || 0) - holdStartY;
      const moveTolerance = holdActive ? SHORT_VIDEO_HOLD_ACTIVE_MOVE_TOLERANCE : SHORT_VIDEO_HOLD_ARM_MOVE_TOLERANCE;
      if (Math.hypot(deltaX, deltaY) <= moveTolerance) return;
      finishPointer(event, { suppressClick: holdActive });
    });
    player.addEventListener("pointerup", (event) => finishPointer(event));
    player.addEventListener("pointercancel", (event) => finishPointer(event, { suppressClick: false }));
    player.addEventListener("pointerleave", (event) => finishPointer(event));
    player.addEventListener("pause", () => stopHold());
    player.addEventListener("emptied", () => stopHold());
    player.addEventListener("contextmenu", (event) => {
      if (!holdTimer && !holdActive) return;
      event.preventDefault();
    });
  }

  function showHoldSpeedFeedback(stage, baseRate) {
    if (!stage) return;
    clearHoldSpeedFeedback(stage);
    stage.classList.add("is-hold-speed");
    const feedback = document.createElement("div");
    feedback.className = "short-video-hold-speed-feedback";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    const badge = document.createElement("span");
    badge.textContent = "2×";
    badge.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = "倍速播放中";
    const hint = document.createElement("small");
    hint.textContent = `松开恢复 ${formatPlaybackRate(baseRate)}`;
    copy.append(label, hint);
    feedback.append(badge, copy);
    stage.append(feedback);
  }

  function clearHoldSpeedFeedback(stage) {
    stage?.classList?.remove("is-hold-speed");
    stage?.querySelector?.(".short-video-hold-speed-feedback")?.remove();
  }

  function markPlayerSoundBlocked(stage) {
    if (!stage) return;
    if (stage.shortVideoSoundHintTimer) window.clearTimeout(stage.shortVideoSoundHintTimer);
    stage.classList.add("is-sound-blocked", "is-sound-hint-visible");
    stage.shortVideoSoundHintTimer = window.setTimeout(() => {
      stage.shortVideoSoundHintTimer = 0;
      stage.classList.remove("is-sound-hint-visible");
    }, 2400);
  }

  function clearPlayerSoundBlocked(stage) {
    if (!stage) return;
    if (stage.shortVideoSoundHintTimer) window.clearTimeout(stage.shortVideoSoundHintTimer);
    stage.shortVideoSoundHintTimer = 0;
    stage.classList.remove("is-sound-blocked", "is-sound-hint-visible");
  }

  function restorePlayerSound(player, stage = player?.closest?.(".short-video-stage")) {
    if (!player) return;
    state.shortVideo.muted = false;
    writeMutedPreference(false);
    player.muted = false;
    player.volume = currentShortVideoVolume();
    clearPlayerSoundBlocked(stage);
    player.play?.().catch(() => {
      if (!player.paused) {
        clearPlayerSoundBlocked(stage);
        return;
      }
      markPlayerSoundBlocked(stage);
      player.muted = true;
      player.play?.().catch(() => {});
    });
  }

  function activeShortVideoFullscreenTarget() {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    return browser ? els.workGrid : null;
  }

  function shortVideoFullscreenActive() {
    const fullscreenElement = document.fullscreenElement;
    return Boolean(fullscreenElement && (
      fullscreenElement === els.workGrid
      || fullscreenElement.classList?.contains?.("short-video-browser")
    ));
  }

  function syncShortVideoDisplayModeControl(control) {
    if (!control) return;
    const smartFill = Boolean(state.shortVideo?.smartFill);
    const label = smartFill ? "关闭智能适配" : "开启智能适配";
    if (control.dataset.shortVideoCompact === "true") {
      setIconButton(control, "clearScreen", label);
    } else {
      control.textContent = "智能";
    }
    control.classList.toggle("active", smartFill);
    control.setAttribute("aria-pressed", String(smartFill));
    control.setAttribute("aria-label", label);
    control.title = smartFill ? "关闭屏幕方向智能扩展" : "根据当前屏幕方向扩大展示区域";
  }

  function shortVideoPlaybackQualityLabel(video) {
    const actual = video?.actualVideo || {};
    const width = Math.max(0, Number(actual.width || video?.width || 0));
    const height = Math.max(0, Number(actual.height || video?.height || 0));
    const pixels = Math.max(0, Number(actual.pixels || (width * height)));
    if (pixels >= 8_000_000 || width >= 3840 || height >= 2160) return "超清 4K";
    if (pixels >= 3_500_000 || width >= 2560 || height >= 1440) return "超清 2K";
    if (pixels >= 2_000_000 || width >= 1920 || height >= 1080) return "高清 1080P";
    if (pixels >= 900_000 || width >= 1280 || height >= 720) return "高清 720P";
    if (pixels > 0) return "标清";
    return "清晰度";
  }

  function shortVideoPlaybackQualityDescription(video) {
    const actual = video?.actualVideo || {};
    const width = Math.max(0, Number(actual.width || video?.width || 0));
    const height = Math.max(0, Number(actual.height || video?.height || 0));
    const bitRate = Math.max(0, Number(actual.bitRate || 0));
    const parts = [shortVideoPlaybackQualityLabel(video)];
    if (width && height) parts.push(`${width} × ${height}`);
    if (bitRate) parts.push(`${(bitRate / 1_000_000).toFixed(1)} Mbps`);
    return parts.join(" · ");
  }

  function toggleShortVideoSmartFill() {
    state.shortVideo.smartFill = !state.shortVideo.smartFill;
    writeSmartFillPreference(SHORT_VIDEO_SMART_FILL_KEY, state.shortVideo.smartFill);
    els.workGrid?.querySelector?.(".short-video-browser")?.classList.toggle("is-smart-fill", state.shortVideo.smartFill);
    els.workGrid?.querySelectorAll?.(".short-video-control-smart-fill")?.forEach(syncShortVideoDisplayModeControl);
    showBrowserToast(state.shortVideo.smartFill ? "已开启智能扩展" : "已关闭智能扩展，画面仍会完整显示");
  }

  function syncShortVideoFullscreenControl(control) {
    if (!control) return;
    const active = shortVideoFullscreenActive();
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
    if (control.dataset.shortVideoFullscreenControl === "settings") {
      const title = control.querySelector("b");
      const detail = control.querySelector("small");
      if (title) title.textContent = active ? "退出全屏" : "全屏播放";
      if (detail) detail.textContent = active ? "返回普通播放页面" : "沉浸观看当前作品";
      return;
    }
    setIconButton(control, "fullscreen", active ? "退出全屏" : (control.dataset.shortVideoFullscreenLabel || "全屏"));
    control.title = `${active ? "退出全屏" : (control.dataset.shortVideoFullscreenLabel || "全屏")}（F）`;
  }

  function syncShortVideoFullscreenControls() {
    els.workGrid?.querySelectorAll?.("[data-short-video-fullscreen-control]")?.forEach(syncShortVideoFullscreenControl);
  }

  async function toggleShortVideoFullscreen() {
    const target = activeShortVideoFullscreenTarget();
    if (!target) return false;
    const exiting = Boolean(document.fullscreenElement);
    if (exiting && typeof document.exitFullscreen !== "function") {
      showBrowserToast("当前浏览器无法退出网页全屏");
      return false;
    }
    if (!exiting && typeof target.requestFullscreen !== "function") {
      showBrowserToast("当前浏览器不支持网页全屏");
      return false;
    }
    try {
      if (exiting) await document.exitFullscreen();
      else await target.requestFullscreen();
      syncShortVideoFullscreenControls();
      return true;
    } catch {
      showBrowserToast(exiting ? "退出全屏失败" : "全屏启动失败");
      return false;
    }
  }

  function createAutoNextControl() {
    const autoNext = document.createElement("button");
    autoNext.type = "button";
    autoNext.className = "short-video-control-toggle short-video-control-auto";
    autoNext.setAttribute("role", "switch");
    const track = document.createElement("span");
    track.className = "short-video-control-switch-track";
    track.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = "连播";
    autoNext.append(track, label);
    autoNext.title = "自动播放下一条";
    const sync = () => {
      const enabled = Boolean(state.shortVideo?.autoNext);
      autoNext.classList.toggle("active", enabled);
      autoNext.setAttribute("aria-pressed", String(enabled));
      autoNext.setAttribute("aria-checked", String(enabled));
      autoNext.setAttribute("aria-label", enabled ? "关闭连播" : "开启连播");
    };
    autoNext.addEventListener("click", () => {
      state.shortVideo.autoNext = !state.shortVideo.autoNext;
      writeAutoNextPreference(state.shortVideo.autoNext);
      syncActivePlaybackMode();
      showBrowserToast(state.shortVideo.autoNext ? "已开启连播" : "已关闭连播");
      sync();
    });
    autoNext.shortVideoSync = sync;
    sync();
    return autoNext;
  }

  function renderGalleryControlBar(video) {
    const bar = document.createElement("div");
    bar.className = "short-video-control-bar is-gallery";
    const hasKnownSound = Boolean(video.sound?.previewUrl);
    bar.classList.toggle("has-sound-control", hasKnownSound);
    const play = document.createElement("button");
    play.type = "button";
    play.className = "short-video-control-icon short-video-gallery-play-toggle";
    const label = document.createElement("span");
    label.className = "short-video-gallery-control-label";
    const livePhoto = video.galleryPresentation === "live-photo";
    const galleryKind = livePhoto ? "实况" : "图集";
    const gallerySummary = livePhoto && Number(video.galleryCount || 0) <= 1 ? "视频" : galleryLabel(video);
    label.append(createIcon("images"), document.createTextNode(`${galleryKind} · ${gallerySummary}`));
    const spacer = document.createElement("span");
    spacer.className = "short-video-gallery-control-spacer";
    const autoNext = createAutoNextControl();
    const original = document.createElement("button");
    original.type = "button";
    original.className = "short-video-control-original";
    original.textContent = "原作品";
    original.addEventListener("click", () => openDouyinLink(video));
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "short-video-control-icon short-video-gallery-sound-toggle";
    const syncSound = () => {
      const gallery = activeGalleryPlayer();
      const paused = Boolean(gallery?.shortVideoGalleryIsPaused?.());
      setIconButton(play, paused ? "play" : "pause", paused ? "继续播放图集" : "暂停图集");
      const localReady = Boolean(video.sound?.localAvailable && video.sound?.previewUrl);
      mute.disabled = false;
      mute.classList.toggle("is-pending", !localReady);
      if (!localReady) {
        mute.removeAttribute("aria-pressed");
        setIconButton(mute, "volumeX", "背景音乐准备中，点击刷新");
        return;
      }
      const player = activePlayer();
      const muted = player ? player.muted : Boolean(state.shortVideo.muted);
      const blocked = Boolean(gallery?.closest?.(".short-video-stage")?.classList.contains("is-sound-blocked"));
      const soundState = String(gallery?.dataset?.gallerySoundState || "");
      const soundLabel = blocked
        ? "开启图集音乐（浏览器已阻止自动播放）"
        : (muted
          ? "开启图集音乐"
          : (paused ? "关闭图集音乐（图集已暂停）" : (soundState === "paused" ? "播放图集音乐" : "关闭图集音乐")));
      mute.classList.toggle("is-muted", muted);
      mute.classList.toggle("is-blocked", blocked);
      mute.setAttribute("aria-pressed", String(muted));
      setIconButton(mute, muted ? "volumeX" : "volume2", soundLabel);
    };
    mute.addEventListener("pointerdown", () => {
      const gallery = activeGalleryPlayer();
      const player = activePlayer();
      const blocked = Boolean(gallery?.closest?.(".short-video-stage")?.classList.contains("is-sound-blocked"));
      if (!player || (!player.muted && !blocked)) return;
      mute.dataset.shortVideoSoundRestoredOnPointerDown = "1";
      gallery?.shortVideoGalleryRestoreSound?.().then((result) => {
        if (result === "blocked") showBrowserToast("浏览器仍在阻止音乐播放，请再点一次声音按钮");
        syncSound();
      });
    });
    mute.addEventListener("click", async () => {
      if (mute.dataset.shortVideoSoundRestoredOnPointerDown === "1") {
        delete mute.dataset.shortVideoSoundRestoredOnPointerDown;
        return;
      }
      let gallery = activeGalleryPlayer();
      let player = activePlayer();
      if (!player) {
        if (mute.getAttribute("aria-busy") === "true") return;
        mute.setAttribute("aria-busy", "true");
        setIconButton(mute, "volumeX", "正在检查背景音乐");
        const ready = await gallery?.shortVideoGalleryRefreshSound?.();
        mute.removeAttribute("aria-busy");
        syncSound();
        if (!ready) {
          showBrowserToast("背景音乐还在下载，稍后再试");
          return;
        }
        gallery = activeGalleryPlayer();
        player = activePlayer();
        const result = await gallery?.shortVideoGalleryRestoreSound?.();
        if (result === "blocked") showBrowserToast("浏览器仍在阻止音乐播放，请再点一次声音按钮");
        syncSound();
        return;
      }
      const blocked = Boolean(gallery?.closest?.(".short-video-stage")?.classList.contains("is-sound-blocked"));
      if (player.muted || blocked) {
        const result = await gallery?.shortVideoGalleryRestoreSound?.();
        if (result === "blocked") showBrowserToast("浏览器仍在阻止音乐播放，请再点一次声音按钮");
        syncSound();
        return;
      }
      if (player && player.paused && !player.muted && !gallery?.shortVideoGalleryIsPaused?.()) {
        gallery?.shortVideoGalleryPlaySound?.();
        syncSound();
        return;
      }
      await toggleActiveMute();
      const nextPlayer = activePlayer();
      if (nextPlayer && !nextPlayer.muted && !gallery?.shortVideoGalleryIsPaused?.()) {
        gallery?.shortVideoGalleryPlaySound?.();
      }
      syncSound();
    });
    play.addEventListener("click", () => {
      activeGalleryPlayer()?.shortVideoGalleryTogglePlayback?.();
      syncSound();
    });
    bar.shortVideoSync = () => {
      syncSound();
      autoNext.shortVideoSync?.();
    };
    bar.shortVideoEnableGallerySound = (sound) => {
      video.sound = sound;
      mute.hidden = false;
      bar.classList.add("has-sound-control");
      syncSound();
    };
    mute.hidden = !hasKnownSound;
    syncSound();
    const full = document.createElement("button");
    full.type = "button";
    full.className = "short-video-control-icon";
    full.dataset.shortVideoFullscreenControl = "icon";
    full.dataset.shortVideoFullscreenLabel = "全屏查看图文";
    syncShortVideoFullscreenControl(full);
    full.addEventListener("click", () => toggleShortVideoFullscreen());
    bar.append(play, label, spacer, autoNext);
    bar.append(mute);
    bar.append(original, full);
    return bar;
  }

  function renderControlBar() {
    const bar = document.createElement("div");
    bar.className = "short-video-control-bar";
    const play = document.createElement("button");
    play.type = "button";
    play.className = "short-video-control-play";
    setIconButton(play, "play", "播放");
    const time = document.createElement("span");
    time.className = "short-video-control-time";
    time.textContent = "0:00 / 0:00";
    const progress = document.createElement("input");
    progress.type = "range";
    progress.className = "short-video-control-progress";
    progress.min = "0";
    progress.max = "1000";
    progress.value = "0";
    progress.setAttribute("aria-label", "播放进度");
    const progressWrap = document.createElement("div");
    progressWrap.className = "short-video-control-progress-wrap";
    const controlSpacer = document.createElement("span");
    controlSpacer.className = "short-video-control-spacer";
    controlSpacer.setAttribute("aria-hidden", "true");
    const seekPreview = document.createElement("output");
    seekPreview.className = "short-video-seek-preview";
    seekPreview.textContent = "0:00";
    seekPreview.setAttribute("aria-hidden", "true");
    progressWrap.append(progress, seekPreview);
    const autoNext = createAutoNextControl();
    const clearScreen = document.createElement("button");
    clearScreen.type = "button";
    clearScreen.className = "short-video-control-toggle short-video-control-clear";
    clearScreen.setAttribute("role", "switch");
    const clearScreenTrack = document.createElement("span");
    clearScreenTrack.className = "short-video-control-switch-track";
    clearScreenTrack.setAttribute("aria-hidden", "true");
    const clearScreenLabel = document.createElement("span");
    clearScreenLabel.textContent = "清屏";
    clearScreen.append(clearScreenTrack, clearScreenLabel);
    clearScreen.title = "隐藏播放器界面（J）";
    const quality = document.createElement("button");
    quality.type = "button";
    quality.className = "short-video-control-quality";
    quality.textContent = shortVideoPlaybackQualityLabel(state.shortVideo?.current);
    quality.title = "当前本地视频清晰度";
    const rate = document.createElement("button");
    rate.type = "button";
    rate.className = "short-video-control-rate";
    rate.textContent = "倍速";
    rate.title = "播放速度";
    const settings = document.createElement("button");
    settings.type = "button";
    settings.className = "short-video-control-icon short-video-control-settings";
    setIconButton(settings, "more", "更多播放设置");
    const pip = document.createElement("button");
    pip.type = "button";
    pip.className = "short-video-control-icon short-video-control-pip";
    setIconButton(pip, "pictureInPicture", "画中画");
    const smartFill = document.createElement("button");
    smartFill.type = "button";
    smartFill.className = "short-video-control-icon short-video-control-smart-fill";
    smartFill.dataset.shortVideoCompact = "true";
    syncShortVideoDisplayModeControl(smartFill);
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "short-video-control-icon";
    setIconButton(mute, "volumeX", "取消静音");
    const volumeControl = document.createElement("div");
    volumeControl.className = "short-video-control-volume";
    const volumePopover = document.createElement("div");
    volumePopover.className = "short-video-volume-popover";
    volumePopover.id = "short-video-volume-popover";
    volumePopover.setAttribute("role", "group");
    volumePopover.setAttribute("aria-label", "音量调整");
    const volume = document.createElement("input");
    volume.type = "range";
    volume.className = "short-video-volume-range";
    volume.min = "0";
    volume.max = "100";
    volume.step = "1";
    volume.value = state.shortVideo.muted ? "0" : String(Math.round(currentShortVideoVolume() * 100));
    const volumeReadout = document.createElement("span");
    volumeReadout.className = "short-video-volume-readout";
    volumePopover.append(volume, volumeReadout);
    volumeControl.append(mute, volumePopover);
    mute.setAttribute("aria-controls", volumePopover.id);
    mute.setAttribute("aria-expanded", "false");
    const full = document.createElement("button");
    full.type = "button";
    full.className = "short-video-control-icon";
    full.dataset.shortVideoFullscreenControl = "icon";
    full.dataset.shortVideoFullscreenLabel = "全屏";
    syncShortVideoFullscreenControl(full);
    let scrubbing = false;
    let progressFrameHandle = 0;
    let progressRaf = 0;
    let progressPlayer = null;
    let lastProgressFrameAt = 0;
    let volumeScrubbing = false, volumeCloseTimer = 0;
    let scrubPlayer = null;
    let scrubWasPlaying = false;
    let scrubTargetTime = 0;
    let scrubSeekRaf = 0;
    const setVolumePopoverOpen = (open) => {
      const expanded = Boolean(open); if (expanded) window.clearTimeout(volumeCloseTimer);
      volumeControl.classList.toggle("is-open", expanded);
      mute.setAttribute("aria-expanded", String(expanded));
      volumePopover.setAttribute("aria-hidden", String(!expanded));
      volumePopover.inert = !expanded;
      bar.closest(".short-video-browser")?.classList.toggle("is-volume-open", expanded);
    };
    const scheduleVolumePopoverClose = (delay = 220) => {
      window.clearTimeout(volumeCloseTimer);
      volumeCloseTimer = window.setTimeout(() => { if (!volumeScrubbing && !volumeControl.matches(":hover") && !volumeControl.contains(document.activeElement)) setVolumePopoverOpen(false); }, Math.max(0, Number(delay || 0)));
    };
    volumeControl.shortVideoSetOpen = setVolumePopoverOpen;
    setVolumePopoverOpen(false);

    const updateSeekPreview = (ratio, duration) => {
      const safeRatio = Math.max(0, Math.min(1, Number(ratio || 0)));
      const width = Math.max(0, progress.getBoundingClientRect().width || progressWrap.clientWidth || 0);
      const bubbleHalfWidth = 30;
      const left = width
        ? Math.max(bubbleHalfWidth, Math.min(width - bubbleHalfWidth, safeRatio * width))
        : 0;
      seekPreview.textContent = formatSeconds(Math.max(0, duration) * safeRatio);
      seekPreview.style.left = width ? `${left}px` : `${safeRatio * 100}%`;
    };

    const updateSeekPreviewFromPointer = (event) => {
      const player = activePlayer();
      if (!player) return;
      const duration = Number(player.duration || 0);
      const rect = progress.getBoundingClientRect();
      if (!duration || !rect.width) return;
      const ratio = (Number(event.clientX || rect.left) - rect.left) / rect.width;
      updateSeekPreview(ratio, duration);
    };

    const applyScrubTarget = (exact = false) => {
      if (scrubSeekRaf) {
        window.cancelAnimationFrame(scrubSeekRaf);
        scrubSeekRaf = 0;
      }
      const player = scrubPlayer;
      if (!player || player !== activePlayer() || !Number.isFinite(scrubTargetTime)) return;
      try {
        if (!exact && typeof player.fastSeek === "function") player.fastSeek(scrubTargetTime);
        else player.currentTime = scrubTargetTime;
      } catch {
        try {
          player.currentTime = scrubTargetTime;
        } catch {}
      }
    };

    const scheduleScrubTarget = (player, target, duration) => {
      scrubPlayer = player;
      scrubTargetTime = Math.max(0, Math.min(duration, Number(target || 0)));
      const ratio = duration ? scrubTargetTime / duration : 0;
      const timeText = `${formatSeconds(scrubTargetTime)} / ${formatSeconds(duration)}`;
      progress.value = String(Math.round(ratio * 1000));
      progress.style.setProperty("--short-video-progress", `${ratio * 100}%`);
      time.textContent = timeText;
      progress.setAttribute("aria-valuetext", timeText);
      updateSeekPreview(ratio, duration);
      if (scrubSeekRaf) return;
      scrubSeekRaf = window.requestAnimationFrame(() => {
        scrubSeekRaf = 0;
        applyScrubTarget(false);
      });
    };

    const seekFromProgressPointer = (event) => {
      const player = activePlayer();
      if (!player) return;
      const duration = Number(player.duration || 0);
      const rect = progress.getBoundingClientRect();
      if (!duration || !rect.width) return;
      const ratio = Math.max(0, Math.min(1, (Number(event.clientX || rect.left) - rect.left) / rect.width));
      scheduleScrubTarget(player, ratio * duration, duration);
    };

    const finishProgressScrub = (event, usePointer = false) => {
      if (!scrubbing) return;
      if (usePointer) seekFromProgressPointer(event);
      const player = scrubPlayer;
      const shouldResume = scrubWasPlaying && player === activePlayer();
      applyScrubTarget(true);
      scrubbing = false;
      progressWrap.classList.remove("is-scrubbing");
      if (progress.hasPointerCapture?.(event?.pointerId)) progress.releasePointerCapture?.(event.pointerId);
      scrubPlayer = null;
      scrubWasPlaying = false;
      if (shouldResume) player.play?.().catch(() => {});
      sync(true);
      scheduleProgressLoop();
    };

    const syncProgress = (player = activePlayer()) => {
      if (!player) return;
      const duration = Number(player.duration || 0);
      const current = Number(player.currentTime || 0);
      const timeText = `${formatSeconds(current)} / ${formatSeconds(duration)}`;
      if (time.textContent !== timeText) time.textContent = timeText;
      const progressValue = duration ? Math.round((current / duration) * 1000) : 0;
      const progressText = String(progressValue);
      if (!scrubbing && progress.value !== progressText) progress.value = progressText;
      progress.style.setProperty("--short-video-progress", `${Math.max(0, Math.min(100, progressValue / 10))}%`);
      if (progress.getAttribute("aria-valuetext") !== timeText) progress.setAttribute("aria-valuetext", timeText);
    };

    const sync = (force = false) => {
      const player = activePlayer();
      if (!player) return;
      setIconButton(play, player.paused ? "play" : "pause", player.paused ? "播放" : "暂停");
      play.title = `${player.paused ? "播放" : "暂停"}（空格）`;
      const volumePercent = player.muted ? 0 : Math.round(currentShortVideoVolume() * 100);
      setIconButton(mute, player.muted ? "volumeX" : "volume2", player.muted ? "取消静音" : "静音");
      mute.title = `${player.muted ? "取消静音" : "静音"}（M）`;
      volume.value = String(volumePercent);
      volume.style.setProperty("--short-video-volume", `${volumePercent}%`);
      volume.setAttribute("aria-label", `音量 ${volumePercent}%`);
      volumeReadout.textContent = `${volumePercent}%`;
      autoNext.shortVideoSync?.();
      const clearScreenActive = Boolean(bar.closest(".short-video-browser")?.classList.contains("is-clear-screen"));
      clearScreen.classList.toggle("active", clearScreenActive);
      clearScreen.setAttribute("aria-pressed", String(clearScreenActive));
      clearScreen.setAttribute("aria-checked", String(clearScreenActive));
      clearScreen.setAttribute("aria-label", clearScreenActive ? "退出清屏" : "开启清屏");
      rate.textContent = "倍速";
      rate.setAttribute("aria-label", `播放速度 ${formatPlaybackRate(state.shortVideo?.playbackRate)}`);
      rate.title = `播放速度：${formatPlaybackRate(state.shortVideo?.playbackRate)}`;
      quality.textContent = shortVideoPlaybackQualityLabel(state.shortVideo?.current);
      quality.setAttribute("aria-label", shortVideoPlaybackQualityDescription(state.shortVideo?.current));
      syncShortVideoDisplayModeControl(smartFill);
      const pictureInPictureAvailable = Boolean(player?.requestPictureInPicture && document.pictureInPictureEnabled);
      const pictureInPictureActive = Boolean(player && document.pictureInPictureElement === player);
      pip.disabled = !pictureInPictureAvailable;
      pip.classList.toggle("active", pictureInPictureActive);
      setIconButton(pip, "pictureInPicture", pictureInPictureActive ? "退出画中画" : "画中画");
      syncProgress(player);
      player.closest(".short-video-stage")?.classList.toggle("is-paused", player.paused);
      syncActivePlaybackMode(player);
    };

    const stopProgressLoop = () => {
      if (progressFrameHandle && progressPlayer?.cancelVideoFrameCallback) {
        progressPlayer.cancelVideoFrameCallback(progressFrameHandle);
      }
      if (progressRaf) window.cancelAnimationFrame(progressRaf);
      progressFrameHandle = 0;
      progressRaf = 0;
      progressPlayer = null;
      lastProgressFrameAt = 0;
    };

    const scheduleProgressLoop = () => {
      if (!bar.isConnected) {
        stopProgressLoop();
        return;
      }
      const player = activePlayer();
      if (!player) {
        stopProgressLoop();
        return;
      }
      if (progressPlayer !== player) {
        stopProgressLoop();
        progressPlayer = player;
      }
      if (player.paused || player.ended) {
        stopProgressLoop();
        syncProgress(player);
        return;
      }
      if (progressFrameHandle || progressRaf) return;
      const paintProgress = (now) => {
        progressFrameHandle = 0;
        progressRaf = 0;
        if (!bar.isConnected || player !== activePlayer()) {
          scheduleProgressLoop();
          return;
        }
        if (!lastProgressFrameAt || now - lastProgressFrameAt >= 30) {
          lastProgressFrameAt = now;
          syncProgress(player);
        }
        scheduleProgressLoop();
      };
      if (player.requestVideoFrameCallback) {
        progressFrameHandle = player.requestVideoFrameCallback(paintProgress);
      } else {
        progressRaf = window.requestAnimationFrame(paintProgress);
      }
    };
    play.addEventListener("click", () => {
      toggleActivePlayer();
      window.requestAnimationFrame(() => sync(true));
    });
    mute.addEventListener("click", () => {
      toggleActiveMute();
      const compactVolume = window.matchMedia?.("(max-width: 680px)")?.matches;
      setVolumePopoverOpen(!compactVolume);
      sync(true);
    });
    volume.addEventListener("input", () => {
      setActiveShortVideoVolume(Number(volume.value || 0));
      sync(true);
    });
    volume.addEventListener("keydown", (event) => {
      const current = Math.max(0, Math.min(100, Number(volume.value || 0)));
      const next = {
        ArrowUp: current + 1,
        ArrowRight: current + 1,
        ArrowDown: current - 1,
        ArrowLeft: current - 1,
        PageUp: current + 10,
        PageDown: current - 10,
        Home: 0,
        End: 100
      }[event.key];
      if (!Number.isFinite(next)) return;
      event.preventDefault();
      volume.value = String(Math.max(0, Math.min(100, next)));
      setActiveShortVideoVolume(Number(volume.value));
      sync(true);
    });
    const setVolumeFromPointer = (event) => {
      const rect = volume.getBoundingClientRect();
      if (!rect.height) return;
      const clientY = Number(event.clientY);
      const ratio = Math.max(0, Math.min(1, (rect.bottom - (Number.isFinite(clientY) ? clientY : rect.bottom)) / rect.height));
      volume.value = String(Math.round(ratio * 100));
      setActiveShortVideoVolume(Number(volume.value || 0));
      sync(true);
    };
    volume.addEventListener("pointerdown", (event) => {
      volumeScrubbing = true;
      setVolumePopoverOpen(true);
      volume.setPointerCapture?.(event.pointerId);
      volume.focus?.({ preventScroll: true });
      setVolumeFromPointer(event);
      event.preventDefault();
    });
    volume.addEventListener("pointermove", (event) => {
      if (!volumeScrubbing) return;
      setVolumeFromPointer(event);
      event.preventDefault();
    });
    const finishVolumeScrub = (event) => {
      if (!volumeScrubbing) return;
      setVolumeFromPointer(event);
      volumeScrubbing = false;
      if (volume.hasPointerCapture?.(event.pointerId)) volume.releasePointerCapture?.(event.pointerId);
    };
    volume.addEventListener("pointerup", finishVolumeScrub);
    volume.addEventListener("pointercancel", () => {
      volumeScrubbing = false;
      sync(true);
    });
    volumeControl.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setVolumePopoverOpen(false);
      activePlayer()?.closest?.(".short-video-stage")?.focus?.({ preventScroll: true });
    });
    volumeControl.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") setVolumePopoverOpen(true);
    });
    volumeControl.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "touch") return;
      scheduleVolumePopoverClose();
    });
    volumeControl.addEventListener("focusin", () => setVolumePopoverOpen(true));
    volumeControl.addEventListener("focusout", () => scheduleVolumePopoverClose(80));
    const closeVolumeFromOutside = (event) => {
      if (!volumeControl.contains(event.target)) setVolumePopoverOpen(false);
    };
    window.addEventListener("pointerdown", closeVolumeFromOutside, true);
    clearScreen.addEventListener("click", () => {
      toggleClearScreen();
      sync(true);
    });
    quality.addEventListener("click", () => {
      showBrowserToast(shortVideoPlaybackQualityDescription(state.shortVideo?.current));
    });
    rate.addEventListener("click", (event) => {
      showPlaybackSettings(state.shortVideo?.current, { trigger: event.currentTarget, focusSpeed: true });
    });
    settings.addEventListener("click", (event) => {
      showPlaybackSettings(state.shortVideo?.current, { trigger: event.currentTarget });
    });
    pip.addEventListener("click", async () => {
      const player = activePlayer();
      if (!player?.requestPictureInPicture || !document.pictureInPictureEnabled) return;
      try {
        if (document.pictureInPictureElement === player) await document.exitPictureInPicture();
        else await player.requestPictureInPicture();
      } catch {
        showBrowserToast("画中画启动失败");
      }
      sync(true);
    });
    smartFill.addEventListener("click", toggleShortVideoSmartFill);
    full.addEventListener("click", () => toggleShortVideoFullscreen());
    progress.addEventListener("pointerenter", (event) => {
      progressWrap.classList.add("is-hovering");
      updateSeekPreviewFromPointer(event);
    });
    progress.addEventListener("pointermove", (event) => {
      progressWrap.classList.add("is-hovering");
      if (scrubbing) seekFromProgressPointer(event);
      else updateSeekPreviewFromPointer(event);
    });
    progress.addEventListener("pointerleave", () => {
      progressWrap.classList.remove("is-hovering");
      if (!scrubbing) sync(true);
    });
    progress.addEventListener("pointerdown", (event) => {
      scrubbing = true;
      scrubPlayer = activePlayer();
      scrubWasPlaying = Boolean(scrubPlayer && !scrubPlayer.paused && !scrubPlayer.ended);
      scrubTargetTime = Math.max(0, Number(scrubPlayer?.currentTime || 0));
      scrubPlayer?.pause?.();
      progress.setPointerCapture?.(event.pointerId);
      progressWrap.classList.add("is-scrubbing");
      seekFromProgressPointer(event);
    });
    progress.addEventListener("pointerup", (event) => finishProgressScrub(event, true));
    progress.addEventListener("pointercancel", (event) => finishProgressScrub(event));
    progress.addEventListener("focus", () => {
      const player = activePlayer();
      const duration = Number(player?.duration || 0);
      updateSeekPreview(Number(progress.value || 0) / 1000, duration);
    });
    progress.addEventListener("input", () => {
      const player = activePlayer();
      if (!player) return;
      const duration = Number(player.duration || 0);
      if (!duration) return;
      const ratio = Number(progress.value || 0) / 1000;
      if (scrubbing) {
        scheduleScrubTarget(player, ratio * duration, duration);
      } else {
        player.currentTime = ratio * duration;
        updateSeekPreview(ratio, duration);
        sync(true);
      }
    });
    const tools = document.createElement("div");
    tools.className = "short-video-control-tools";
    tools.append(autoNext, clearScreen, quality, rate, settings, pip, volumeControl, smartFill, full);
    bar.append(play, time, progressWrap, controlSpacer, tools);
    bar.shortVideoSync = () => {
      sync();
      scheduleProgressLoop();
    };
    bar.shortVideoDispose = () => {
      setVolumePopoverOpen(false);
      stopProgressLoop();
      if (scrubSeekRaf) window.cancelAnimationFrame(scrubSeekRaf);
      scrubSeekRaf = 0;
      scrubPlayer = null;
      window.removeEventListener("pointerdown", closeVolumeFromOutside, true);
    };
    window.requestAnimationFrame(() => bar.shortVideoSync?.());
    return bar;
  }

  async function openAdjacent(direction, options = {}) {
    const id = direction < 0 ? state.shortVideo.prevId : state.shortVideo.nextId;
    if (!id) {
      if (queuedAdjacentDirection === direction) queuedAdjacentDirection = 0;
      pulseBoundaryStack(direction);
      return;
    }
    shortVideoAdjacentWarmDirection = direction < 0 ? -1 : 1;
    const navigationStartedAt = Date.now();
    const incomingPlayer = adjacentPlayer(direction);
    markShortVideoPerformance("adjacent-switch-start", {
      videoId: String(id),
      direction: Number(direction || 0),
      frameReady: incomingPlayer?.dataset.shortVideoFrameReady === "1",
      readyState: Number(incomingPlayer?.readyState || 0)
    });
    clearPendingPlayerClick();
    closeTransientPlayerControls();
    if (wheelLocked) {
      queuedAdjacentDirection = direction;
      return;
    }
    shortVideoLastNavigationAt = Date.now();
    const cachedVideo = (direction < 0 ? state.shortVideo.prevVideo : state.shortVideo.nextVideo)
      || cachedShortVideo(id);
    const hasCachedAdjacent = cachedVideo?.id === id;
    const canPromoteVideoPanel = hasCachedAdjacent
      && !isGalleryPost(state.shortVideo.current)
      && !isGalleryPost(cachedVideo);
    if (!canPromoteVideoPanel) flushActiveShortVideoWatch();
    wheelLocked = true;
    wheelDeltaY = 0;
    queuedAdjacentDirection = 0;
    wheelIgnoreUntil = Date.now() + 180;
    window.clearTimeout(wheelResetTimer);
    try {
      const animationPromise = animateActiveStack(direction, {
        ...(options.motion || {}),
        prewarmed: incomingPlayer?.dataset.shortVideoFrameReady === "1" && incomingPlayer.readyState >= 2
      });
      const primePromise = primeAdjacentSound(direction, cachedVideo).catch(() => false);
      const [, incomingReady] = await Promise.all([
        animationPromise,
        primePromise
      ]);
      if (canPromoteVideoPanel && incomingPlayer && !incomingReady) {
        markShortVideoPerformance("adjacent-switch-promoting-unready", {
          videoId: String(id),
          direction: Number(direction || 0),
          durationMs: Date.now() - navigationStartedAt,
          readyState: Number(incomingPlayer.readyState || 0)
        });
      }
      if (canPromoteVideoPanel) {
        promoteAdjacentPanelDom(direction, cachedVideo);
        await promoteAdjacentMedia(cachedVideo, direction);
      } else if (hasCachedAdjacent) {
        await promoteAdjacentMedia(cachedVideo, direction, { renderCurrent: true });
      } else {
        await openVideo(id, { renderLoading: false });
      }
      markShortVideoPerformance("adjacent-switch-ready", {
        videoId: String(state.shortVideo.current?.id || id),
        direction: Number(direction || 0),
        durationMs: Date.now() - navigationStartedAt,
        promoted: canPromoteVideoPanel,
        cached: hasCachedAdjacent
      });
      markShortVideoCacheState();
    } finally {
      wheelIgnoreUntil = Date.now();
      wheelLocked = false;
      scheduleWheelGestureRelease();
      flushQueuedAdjacent();
    }
  }

  function flushQueuedAdjacent() {
    const direction = queuedAdjacentDirection;
    queuedAdjacentDirection = 0;
    if (!direction || state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
    const id = direction < 0 ? state.shortVideo.prevId : state.shortVideo.nextId;
    if (!id) return;
    openAdjacent(direction).catch(showError);
  }

  async function primeAdjacentSound(direction, video) {
    const player = adjacentPlayer(direction);
    if (!player) return false;
    // A delayed warm/release callback created while this player was an
    // off-screen ghost must not be allowed to clear its src mid-transition.
    player.dataset.shortVideoWarmScheduleToken = String(++shortVideoAdjacentWarmScheduleId);
    const ready = await warmAdjacentVideoPlayer(player, video, {
      forceReload: Boolean(
        player.error
        || player.dataset.shortVideoDecoderReleased === "1"
        || !(player.currentSrc || player.getAttribute("src"))
      ),
      pauseAfter: false,
      timeout: SHORT_VIDEO_SWITCH_PRIME_TIMEOUT_MS
    });
    if (player.currentTime > 0.12) {
      try {
        player.currentTime = 0;
      } catch {}
    }
    // Keep the incoming reel silent until the visual handoff finishes. The
    // promoted player restores the user's sound preference in one step.
    player.muted = true;
    player.volume = currentShortVideoVolume();
    player.playbackRate = normalizePlaybackRate(state.shortVideo.playbackRate);
    player.play?.().catch(() => {});
    return ready || player.readyState >= 2;
  }

  function adjacentPlayer(direction) {
    const selector = direction > 0
      ? ".short-video-reel-panel.is-next .short-video-player"
      : ".short-video-reel-panel.is-prev .short-video-player";
    return els.workGrid?.querySelector?.(selector) || null;
  }

  function scheduleAdjacentVideoWarmup(player, video, slot = "next") {
    if (!player) return;
    const scheduleToken = String(++shortVideoAdjacentWarmScheduleId);
    player.dataset.shortVideoWarmScheduleToken = scheduleToken;
    const preferredSlot = shortVideoAdjacentWarmDirection < 0 ? "prev" : "next";
    if (slot !== preferredSlot) {
      window.setTimeout(() => {
        if (player.dataset.shortVideoWarmScheduleToken !== scheduleToken) return;
        releaseOffscreenVideoDecoder(player, `adjacent-${slot}`);
      }, 80);
      return;
    }
    const startedAt = Date.now();
    const rapidNavigation = shortVideoLastNavigationAt > 0
      && startedAt - shortVideoLastNavigationAt <= SHORT_VIDEO_RAPID_NAV_WARM_WINDOW_MS;
    const stableDelayMs = rapidNavigation
      ? SHORT_VIDEO_ADJACENT_WARM_RAPID_MS
      : SHORT_VIDEO_ADJACENT_WARM_STABLE_MS;
    let warmStarted = false;
    const warm = () => {
      if (
        !player.isConnected
        || !player.classList.contains("is-ghost")
        || player.dataset.shortVideoWarmScheduleToken !== scheduleToken
      ) return;
      const currentPreferredSlot = shortVideoAdjacentWarmDirection < 0 ? "prev" : "next";
      if (slot !== currentPreferredSlot) {
        releaseOffscreenVideoDecoder(player, `adjacent-${slot}`);
        return;
      }
      const current = activePlayer();
      if (current && current !== player) {
        const elapsed = Date.now() - startedAt;
        if (current.dataset.shortVideoFrameReady !== "1" && elapsed < 5200) {
          window.setTimeout(warm, 120);
          return;
        }
        const currentFrameReadyAt = Number(current.dataset.shortVideoFrameReadyAt || 0);
        const currentCooldown = stableDelayMs - (Date.now() - currentFrameReadyAt);
        if (currentFrameReadyAt && currentCooldown > 0) {
          window.setTimeout(warm, currentCooldown);
          return;
        }
      }
      if (warmStarted) return;
      warmStarted = true;
      const warmStartedAt = Date.now();
      markShortVideoPerformance("adjacent-warm-start", {
        videoId: String(video?.id || player.dataset.videoId || ""),
        slot,
        deferredMs: warmStartedAt - startedAt,
        mode: rapidNavigation ? "rapid-navigation" : "steady-playback",
        stableDelayMs
      });
      warmAdjacentVideoPlayer(player, video, { pauseAfter: true, timeout: 1200 }).then((ready) => {
        markShortVideoPerformance("adjacent-warm-finish", {
          videoId: String(video?.id || player.dataset.videoId || ""),
          slot,
          ready: Boolean(ready),
          durationMs: Date.now() - warmStartedAt,
          readyState: Number(player.readyState || 0)
        });
      }).catch(() => {});
    };
    window.setTimeout(warm, rapidNavigation ? 0 : (slot === "next" ? 40 : 220));
  }

  function warmVisibleAdjacentVideoPlayers() {
    const stack = activeReelStack();
    const preferredSlot = shortVideoAdjacentWarmDirection < 0 ? "prev" : "next";
    const preferred = stack?.querySelector?.(`.short-video-reel-panel.is-${preferredSlot} .short-video-player`);
    const oppositeSlot = preferredSlot === "next" ? "prev" : "next";
    const opposite = stack?.querySelector?.(`.short-video-reel-panel.is-${oppositeSlot} .short-video-player`);
    releaseOffscreenVideoDecoder(opposite, `adjacent-${oppositeSlot}`);
    if (!preferred) return;
    warmAdjacentVideoPlayer(preferred, null, {
      forceReload: Boolean(preferred.error),
      pauseAfter: true,
      timeout: 1200
    }).catch(() => {});
  }

  function releaseOffscreenVideoDecoder(player, reason = "offscreen") {
    if (!player || player.dataset.shortVideoSlot === "current") return false;
    const source = String(player.dataset.streamUrl || player.currentSrc || player.getAttribute("src") || "").trim();
    const hadMedia = Boolean(player.currentSrc || player.getAttribute("src") || player.readyState > 0);
    const retainPlayedAdjacent = reason.startsWith("adjacent-")
      && player.dataset.shortVideoPlayed === "1"
      && !player.error
      && player.readyState >= 2
      && hadMedia;
    if (retainPlayedAdjacent) {
      player.muted = true;
      player.pause?.();
      player.preload = "auto";
      delete player.dataset.shortVideoDecoderReleased;
      const retentionKey = `${player.dataset.shortVideoSlot || ""}:${reason}`;
      if (player.dataset.shortVideoDecoderRetentionKey !== retentionKey) {
        player.dataset.shortVideoDecoderRetentionKey = retentionKey;
        markShortVideoPerformance("video-decoder-retained", {
          videoId: String(player.dataset.videoId || ""),
          slot: String(player.dataset.shortVideoSlot || ""),
          reason,
          readyState: Number(player.readyState || 0)
        });
      }
      return false;
    }
    if (source) player.dataset.streamUrl = source;
    player.muted = true;
    player.pause?.();
    player.preload = "none";
    delete player.dataset.shortVideoPlayed;
    delete player.dataset.shortVideoDecoderRetentionKey;
    delete player.dataset.shortVideoFrameReady;
    delete player.dataset.shortVideoFrameReadyAt;
    player.dataset.shortVideoDecoderReleased = "1";
    player.removeAttribute("src");
    player.load?.();
    if (hadMedia) {
      markShortVideoPerformance("video-decoder-released", {
        videoId: String(player.dataset.videoId || ""),
        slot: String(player.dataset.shortVideoSlot || ""),
        reason
      });
    }
    return hadMedia;
  }

  function promoteAdjacentPanelDom(direction, video) {
    const stack = activeReelStack();
    if (!stack) return;
    const incoming = stack.querySelector(direction > 0 ? ".short-video-reel-panel.is-next" : ".short-video-reel-panel.is-prev");
    const outgoing = stack.querySelector(".short-video-reel-panel.is-current");
    if (!incoming || !outgoing) return;

    stack.classList.add("is-rebasing");
    stack.style.transition = "none";
    stack.classList.remove("is-snap-next", "is-snap-prev", "is-dragging");
    stack.style.setProperty("--short-video-drag-y", "0px");
    incoming.classList.remove("is-next", "is-prev", "is-ghost-panel");
    incoming.classList.add("is-current");
    setReelPanelInteractionState(incoming, true);
    outgoing.classList.remove("is-current");
    outgoing.classList.add(direction > 0 ? "is-prev" : "is-next", "is-ghost-panel");
    setReelPanelInteractionState(outgoing, false);
    stack.querySelectorAll(".short-video-reel-panel.is-ghost-panel").forEach((panel) => {
      if (panel !== outgoing) disposeReelPanel(panel);
    });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        stack.classList.remove("is-rebasing");
        stack.style.removeProperty("transition");
        incoming.shortVideoSyncCaptionOverflow?.();
      });
    });

    // Silence the outgoing reel before restoring sound on the incoming one.
    // The adjacent player may already be running muted for first-frame warmup,
    // so unmuting it first would briefly leave two audible players alive.
    const previousPlayer = outgoing.querySelector(".short-video-player");
    if (previousPlayer) {
      previousPlayer.classList.add("is-ghost");
      previousPlayer.dataset.shortVideoSlot = direction > 0 ? "prev" : "next";
      previousPlayer.dataset.shortVideoPlayed = "1";
      previousPlayer.muted = true;
      previousPlayer.pause?.();
      try {
        previousPlayer.currentTime = 0;
      } catch {}
    }
    const player = incoming.querySelector(".short-video-player");
    const stage = incoming.querySelector(".short-video-stage");
    if (player && stage) {
      // Promotion invalidates every timer scheduled for the old ghost role.
      // Restore the source before changing slot/play state in case a timer
      // already released the decoder during the navigation animation.
      player.dataset.shortVideoWarmScheduleToken = String(++shortVideoAdjacentWarmScheduleId);
      player.classList.remove("is-ghost");
      player.dataset.shortVideoSlot = "current";
      player.dataset.shortVideoPlayed = "1";
      player.dataset.shortVideoPromotedAt = String(Date.now());
      delete player.dataset.shortVideoDecoderRetentionKey;
      player.preload = "auto";
      player.fetchPriority = "high";
      player.setAttribute("fetchpriority", "high");
      ensureShortVideoPlayerSource(player, video, {
        forceReload: Boolean(
          player.error
          || player.dataset.shortVideoDecoderReleased === "1"
          || !(player.currentSrc || player.getAttribute("src"))
        ),
        reason: "adjacent-promotion"
      });
      player.muted = Boolean(state.shortVideo.muted);
      player.volume = currentShortVideoVolume();
      if (player.dataset.primaryControlsBound !== "1") {
        attachPrimaryPlayerControls(stage, player, () => incoming.querySelector(".short-video-rail"), video, { resume: false });
      }
      const likeButton = incoming.querySelector(".short-video-rail-button.is-like");
      if (likeButton && !likeButton.dataset.boundPrimaryLike) {
        likeButton.dataset.boundPrimaryLike = "1";
        likeButton.addEventListener("click", (event) => {
          toggleShortVideoAction(state.shortVideo?.current, "like", likeButton);
          showHeartBurst(stage, event);
        });
      }
      player.play?.().catch(() => {
        if (!state.shortVideo.muted) {
          markPlayerSoundBlocked(stage);
          player.muted = true;
          player.play?.().catch(() => {});
        }
      });
      markShortVideoPerformance("video-player-promoted", {
        videoId: String(video?.id || player.dataset.videoId || ""),
        direction: Number(direction || 0),
        slot: "current",
        prewarmed: player.dataset.shortVideoFrameReady === "1",
        readyState: Number(player.readyState || 0)
      });
    }

  }

  function promoteAdjacentMedia(video, direction, options = {}) {
    const previousCurrent = state.shortVideo.current;
    const collectionNavigation = collectionsController.collectionNavigation(video.id);
    const navigation = collectionNavigation || (state.shortVideo.mode === "collection" ? null : cachedShortVideoNavigation(video.id));
    const fallbackPrevId = direction > 0 ? previousCurrent?.id || "" : "";
    const fallbackNextId = direction < 0 ? previousCurrent?.id || "" : "";
    state.shortVideo.current = video;
    state.shortVideo.slideDirection = 0;
    state.shortVideo.loading = false;
    state.shortVideo.status = "";
    state.shortVideo.prevId = navigation?.prevId || fallbackPrevId;
    state.shortVideo.nextId = navigation?.nextId || fallbackNextId;
    state.shortVideo.prevVideo = collectionNavigation?.prevVideo || cachedShortVideo(state.shortVideo.prevId)
      || (previousCurrent?.id === state.shortVideo.prevId ? previousCurrent : null);
    state.shortVideo.nextVideo = collectionNavigation?.nextVideo || cachedShortVideo(state.shortVideo.nextId)
      || (previousCurrent?.id === state.shortVideo.nextId ? previousCurrent : null);
    replaceRoute({ view: "shortVideos", shortVideoId: video.id });
    syncActiveControlBar();
    if (options.renderCurrent) {
      renderStats();
      renderView();
      resumeActiveSound();
    } else {
      refreshAdjacentPanelsDom();
    }
    scheduleAdjacentNavigationPrefetch();
    hydratePromotedShortVideo(video).catch((error) => console.warn(error));
  }

  async function hydratePromotedShortVideo(video) {
    try {
      const data = await contextualShortVideoDetail(video.id);
      if (state.shortVideo.current?.id !== video.id) return;
      state.shortVideo.current = data.video || video;
      cacheAuthorPanelVideo(state.shortVideo.current);
      const collectionNavigation = collectionsController.collectionNavigation(video.id);
      state.shortVideo.prevId = collectionNavigation?.prevId || data.prevId || "";
      state.shortVideo.nextId = collectionNavigation?.nextId || data.nextId || "";
      state.shortVideo.prevVideo = collectionNavigation?.prevVideo || data.prevVideo || cachedShortVideo(state.shortVideo.prevId);
      state.shortVideo.nextVideo = collectionNavigation?.nextVideo || data.nextVideo || cachedShortVideo(state.shortVideo.nextId);
      await loadAdjacentVideos(video.id);
      if (state.shortVideo.current?.id === video.id) {
        refreshAdjacentPanelsDom();
        syncAuthorPanelCurrentTile();
      }
      resumeActiveSound();
    } catch (error) {
      if (state.shortVideo.current?.id === video.id) {
        refreshAdjacentPanelsDom();
        syncAuthorPanelCurrentTile();
        resumeActiveSound();
      }
      throw error;
    }
  }

  function scheduleInitialAdjacentPanelsRefresh(videoId) {
    const expectedVideoId = String(videoId || "");
    const player = activePlayer();
    const scheduledAt = Date.now();
    const refresh = () => {
      if (String(state.shortVideo?.current?.id || "") !== expectedVideoId) return;
      const startedAt = Date.now();
      markShortVideoPerformance("adjacent-panels-refresh-start", {
        videoId: expectedVideoId,
        deferredMs: startedAt - scheduledAt,
        currentFrameReady: player?.dataset?.shortVideoFrameReady === "1"
      });
      refreshAdjacentPanelsDom();
      syncCurrentNavigationDom();
      markShortVideoPerformance("adjacent-panels-refresh-finish", {
        videoId: expectedVideoId,
        durationMs: Date.now() - startedAt
      });
    };
    if (!player || isGalleryPost(state.shortVideo?.current)) {
      refresh();
      return;
    }
    waitForVideoFirstFrame(player, SHORT_VIDEO_FIRST_FRAME_TIMEOUT_MS).finally(() => {
      if (String(state.shortVideo?.current?.id || "") !== expectedVideoId) return;
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(refresh, { timeout: 96 });
      } else {
        window.requestAnimationFrame(refresh);
      }
    });
  }

  function refreshAdjacentPanelsDom() {
    const stack = activeReelStack();
    if (!stack || !state.shortVideo?.current) {
      renderView();
      return;
    }
    const currentPanel = stack.querySelector(".short-video-reel-panel.is-current");
    if (!currentPanel) {
      renderView();
      return;
    }
    const existingGhosts = [...stack.querySelectorAll(".short-video-reel-panel.is-ghost-panel")];
    const reusedGhosts = new Set();
    const placeGhost = (video, slot) => {
      if (!video?.id) return;
      const videoId = String(video.id);
      let panel = existingGhosts.find((candidate) => !reusedGhosts.has(candidate) && candidate.dataset.videoId === videoId);
      if (panel) {
        reusedGhosts.add(panel);
        panel.classList.remove("is-current", "is-prev", "is-next");
        panel.classList.add(`is-${slot}`, "is-ghost-panel");
        setReelPanelInteractionState(panel, false);
        const player = panel.querySelector(".short-video-player");
        if (player) {
          player.classList.add("is-ghost");
          player.dataset.shortVideoSlot = slot;
          player.muted = true;
          player.pause?.();
          scheduleAdjacentVideoWarmup(player, video, slot);
        }
      } else {
        panel = renderReelPanel(video, { ghost: true, slot }).panel;
      }
      if (slot === "prev") stack.insertBefore(panel, currentPanel);
      else stack.append(panel);
    };
    placeGhost(state.shortVideo.prevVideo, "prev");
    placeGhost(state.shortVideo.nextVideo, "next");
    existingGhosts.forEach((panel) => {
      if (!reusedGhosts.has(panel)) disposeReelPanel(panel);
    });
    syncCurrentNavigationDom();
  }

  function disposeReelPanel(panel) {
    if (!panel) return;
    panel.querySelectorAll?.("video")?.forEach?.((player) => {
      player.muted = true;
      player.pause?.();
      player.removeAttribute("src");
      player.load?.();
    });
    panel.remove();
  }

  function syncCurrentNavigationDom() {
    const buttons = els.workGrid?.querySelectorAll?.(".short-video-browser > .short-video-nav-pair .short-video-rail-button.is-nav");
    if (!buttons?.length) return;
    if (buttons[0]) buttons[0].disabled = !state.shortVideo.prevId;
    if (buttons[1]) buttons[1].disabled = !state.shortVideo.nextId;
  }

  function syncShortVideoBrowserSearchDom() {
    shortVideoSearch.syncTrigger(els.workGrid);
  }

  function shortVideoFeedSnapshot() {
    return {
      author: state.shortVideo?.author || "all",
      source: state.shortVideo?.source || "liked",
      query: state.shortVideo?.query || "",
      topic: state.shortVideo?.topic || "",
      sound: state.shortVideo?.sound || "",
      soundInfo: state.shortVideo?.soundInfo || null,
      media: state.shortVideo?.media || "all",
      quality: state.shortVideo?.quality || "all",
      sort: state.shortVideo?.sort || "published"
    };
  }

  function applyShortVideoFeedSnapshot(feed = {}) {
    state.shortVideo.author = feed.author || "all";
    state.shortVideo.source = normalizeShortVideoSource(feed.source || "liked");
    state.shortVideo.query = feed.query || "";
    state.shortVideo.topic = normalizeShortVideoTopic(feed.topic);
    state.shortVideo.sound = normalizeShortVideoSound(feed.sound);
    state.shortVideo.soundInfo = feed.soundInfo || null;
    state.shortVideo.media = normalizeShortVideoMedia(feed.media);
    state.shortVideo.quality = normalizeShortVideoQuality(feed.quality);
    state.shortVideo.sort = feed.sort || "published";
    state.shortVideo.data = null;
  }

  function clearAuthorPanelCaches() {
    authorPanelVideoCache = null;
    authorPanelTileMap = null;
  }

  function cacheAuthorPanelVideos(videos = []) {
    const cache = new Map();
    for (const video of videos) {
      const id = String(video?.id || "").trim();
      if (id) {
        cache.set(id, video);
        rememberShortVideo(video);
      }
    }
    authorPanelVideoCache = cache.size ? cache : null;
  }

  function cacheAuthorPanelVideo(video) {
    const id = String(video?.id || "").trim();
    if (!id || !authorPanelVideoCache) return;
    rememberShortVideo(video);
    authorPanelVideoCache.set(id, video);
  }

  function cachedAuthorPanelVideo(id) {
    const key = String(id || "").trim();
    return key ? authorPanelVideoCache?.get(key) || null : null;
  }

  function closeAuthorPanel(panel, options = {}) {
    if (!panel || panel.dataset.closing === "1") return;
    const browser = panel.closest?.(".short-video-browser");
    const returnFocus = panel._shortVideoReturnFocus;
    panel._shortVideoDragAbort?.abort?.();
    panel._shortVideoDragAbort = null;
    browser?.classList.remove("is-author-panel-open");
    panel?.querySelectorAll?.(".short-video-sound-audio")?.forEach?.((audio) => {
      try {
        audio.pause?.();
        audio.removeAttribute?.("src");
        audio.load?.();
      } catch {}
    });
    authorPanelVideoRequestId += 1;
    clearAuthorPanelCaches();
    if (options.restoreFeed === false) authorPanelReturnFeed = null;
    let finished = false;
    let handleTransitionEnd = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (panel._shortVideoCloseTimer) window.clearTimeout(panel._shortVideoCloseTimer);
      panel._shortVideoCloseTimer = 0;
      if (handleTransitionEnd) panel.removeEventListener("transitionend", handleTransitionEnd);
      panel._shortVideoContextTabsObserver?.disconnect?.();
      panel._shortVideoContextTabsObserver = null;
      const fallbackFocus = resolveAuthorPanelReturnFocus(panel, returnFocus);
      restoreAuthorPanelModalIsolation(panel);
      panel.remove();
      if (options.restoreFocus !== false && fallbackFocus?.isConnected) {
        fallbackFocus.focus?.({ preventScroll: true });
      }
      if (options.restoreFeed !== false) restoreAuthorPanelFeed().catch(showError);
    };
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (options.animate === false || reduceMotion || !panel.isConnected) {
      finish();
      return;
    }
    panel.dataset.closing = "1";
    panel.classList.add("is-closing");
    panel.classList.remove("is-open");
    handleTransitionEnd = (event) => {
      if (event.propertyName === "transform") finish();
    };
    panel.addEventListener("transitionend", handleTransitionEnd);
    panel._shortVideoCloseTimer = window.setTimeout(finish, 1000);
  }

  function resolveAuthorPanelReturnFocus(panel, returnFocus) {
    const current = panel?.closest?.(".short-video-browser")?.querySelector?.(".short-video-reel-panel.is-current");
    if (!current) return null;
    const visible = (element) => Boolean(element?.isConnected && element.getClientRects?.().length);
    const returnPanel = returnFocus?.closest?.(".short-video-reel-panel");
    if (visible(returnFocus) && (!returnPanel || returnPanel === current)) return returnFocus;
    const tab = String(panel.dataset.returnFocusTab || "").trim();
    const selector = tab === "related"
      ? ".short-video-caption-author, .short-video-rail-button.is-author"
      : tab === "comments"
      ? ".short-video-rail-button.is-comment"
      : tab === "ai"
      ? ".short-video-identify-button, .short-video-rail-button.is-ai"
      : tab === "sound"
      ? ".short-video-caption-sound, .short-video-rail-button.is-listen"
      : tab === "topic"
      ? ".short-video-caption-tag"
      : ".short-video-caption-author, .short-video-rail-button.is-author";
    const candidates = [...current.querySelectorAll(selector)].filter(visible);
    if (tab !== "topic") return candidates[0] || null;
    const topic = String(panel.dataset.returnFocusTopic || "").trim();
    return candidates.find((element) => element.textContent?.trim() === `#${topic}`) || candidates[0] || null;
  }

  function isolateAuthorPanelAsMobileModal(panel, sheet, browser, initialFocus) {
    if (!panel || !sheet || !browser || !window.matchMedia?.("(max-width: 680px)")?.matches) return;
    panel.setAttribute("aria-modal", "true");
    panel._shortVideoModalSiblings = [...browser.children]
      .filter((element) => element !== panel)
      .map((element) => ({ element, wasInert: element.hasAttribute("inert") }));
    for (const item of panel._shortVideoModalSiblings) item.element.setAttribute("inert", "");
    bindShortVideoModalFocusLoop(panel, sheet, () => closeAuthorPanel(panel));
    window.requestAnimationFrame(() => initialFocus?.focus?.({ preventScroll: true }));
  }

  function restoreAuthorPanelModalIsolation(panel) {
    for (const item of panel?._shortVideoModalSiblings || []) {
      if (!item.wasInert && item.element?.isConnected) item.element.removeAttribute("inert");
    }
    panel._shortVideoModalSiblings = null;
  }

  function bindAuthorPanelDragToClose(panel, sheet, handle) {
    if (!panel || !sheet || !handle) return;
    panel._shortVideoDragAbort?.abort?.();
    const dragAbort = new AbortController();
    panel._shortVideoDragAbort = dragAbort;
    let pointerId = -1;
    let startY = 0;
    let lastY = 0;
    let lastAt = 0;
    let velocityY = 0;
    let dragY = 0;
    let moved = false;
    let mouseFallbackActive = false;
    let suppressClickUntil = 0;
    const mobileSheet = () => window.matchMedia?.("(max-width: 680px)")?.matches;
    const clearDrag = () => {
      pointerId = -1;
      mouseFallbackActive = false;
      sheet.classList.remove("is-dragging");
      handle.removeAttribute("aria-pressed");
    };
    const beginDrag = (clientY, nextPointerId, eventTime) => {
      pointerId = nextPointerId;
      startY = clientY;
      lastY = clientY;
      lastAt = eventTime || Date.now();
      velocityY = 0;
      dragY = 0;
      moved = false;
      sheet.classList.add("is-dragging");
      sheet.style.setProperty("--short-video-author-sheet-drag-y", "0px");
      handle.setAttribute("aria-pressed", "true");
    };
    const moveDrag = (clientY, eventTime) => {
      const nextY = Math.max(0, clientY - startY);
      const now = eventTime || Date.now();
      const elapsed = Math.max(1, now - lastAt);
      velocityY = Math.max(0, (clientY - lastY) / elapsed);
      lastY = clientY;
      lastAt = now;
      dragY = Math.min(nextY, Math.max(180, sheet.clientHeight * .82));
      moved = moved || dragY > 4;
      sheet.style.setProperty("--short-video-author-sheet-drag-y", `${dragY}px`);
    };
    const settle = (event, cancelled = false) => {
      if (pointerId < 0 || (event?.pointerId != null && event.pointerId !== pointerId)) return;
      try {
        handle.releasePointerCapture?.(pointerId);
      } catch {}
      const closeDistance = Math.min(160, Math.max(96, sheet.clientHeight * .2));
      const shouldClose = !cancelled && (dragY >= closeDistance || (dragY >= 28 && velocityY >= .62));
      if (moved) suppressClickUntil = Date.now() + 280;
      clearDrag();
      if (shouldClose) {
        sheet.style.setProperty("--short-video-author-sheet-drag-y", `${Math.max(dragY, 120)}px`);
        closeAuthorPanel(panel);
        return;
      }
      sheet.style.setProperty("--short-video-author-sheet-drag-y", "0px");
    };
    handle.addEventListener("pointerdown", (event) => {
      if (!mobileSheet() || panel.dataset.closing === "1") return;
      beginDrag(event.clientY, event.pointerId, event.timeStamp);
      try {
        handle.setPointerCapture?.(pointerId);
      } catch {}
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId) return;
      moveDrag(event.clientY, event.timeStamp);
      event.preventDefault();
    });
    handle.addEventListener("pointerup", (event) => settle(event));
    handle.addEventListener("pointercancel", (event) => settle(event, true));
    window.addEventListener("pointerup", (event) => settle(event), {
      signal: dragAbort.signal,
      capture: true
    });
    window.addEventListener("pointercancel", (event) => settle(event, true), {
      signal: dragAbort.signal,
      capture: true
    });
    handle.addEventListener("mousedown", (event) => {
      if (!mobileSheet() || panel.dataset.closing === "1" || pointerId >= 0) return;
      mouseFallbackActive = true;
      beginDrag(event.clientY, -2, event.timeStamp);
      event.preventDefault();
    });
    window.addEventListener("mousemove", (event) => {
      if (pointerId >= 0) {
        moveDrag(event.clientY, event.timeStamp);
        event.preventDefault();
        return;
      }
      if (!mouseFallbackActive || pointerId !== -2) return;
      moveDrag(event.clientY, event.timeStamp);
      event.preventDefault();
    }, { signal: dragAbort.signal });
    window.addEventListener("mouseup", (event) => {
      if (pointerId >= 0) {
        settle({ pointerId });
        event.preventDefault();
        return;
      }
      if (!mouseFallbackActive || pointerId !== -2) return;
      settle({ pointerId: -2 });
      event.preventDefault();
    }, { signal: dragAbort.signal });
    handle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < suppressClickUntil) return;
      closeAuthorPanel(panel);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      closeAuthorPanel(panel);
    });
  }

  async function restoreAuthorPanelFeed() {
    const returnFeed = authorPanelReturnFeed;
    authorPanelReturnFeed = null;
    if (!returnFeed) return;
    applyShortVideoFeedSnapshot(returnFeed);
    const currentId = state.shortVideo?.current?.id || "";
    if (!currentId) {
      replaceRoute({ view: "shortVideos", shortVideoId: "" });
      return;
    }
    const data = await fetchShortVideoDetail(currentId);
    if (state.shortVideo?.current?.id !== currentId) return;
    state.shortVideo.current = data.video || state.shortVideo.current;
    state.shortVideo.prevId = data.prevId || "";
    state.shortVideo.nextId = data.nextId || "";
    await loadAdjacentVideos(currentId);
    if (state.shortVideo?.current?.id !== currentId) return;
    renderStats();
    refreshAdjacentPanelsDom();
    syncShortVideoBrowserSearchDom();
    replaceRoute({ view: "shortVideos", shortVideoId: currentId });
  }

  function syncAuthorPanelCurrentTile() {
    const panel = els.workGrid?.querySelector?.(".short-video-author-panel");
    const grid = panel?.querySelector?.(".short-video-author-grid");
    const current = state.shortVideo?.current;
    if (!panel || !grid || !current?.id) return;
    const previousTile = grid.querySelector(".short-video-author-tile.is-current");
    const currentId = String(current.id || "").trim();
    const currentAwemeId = String(current.awemeId || "").trim();
    const nextTile = authorPanelTileMap?.get(`id:${currentId}`)
      || (currentAwemeId ? authorPanelTileMap?.get(`aweme:${currentAwemeId}`) : null)
      || null;
    if (previousTile && previousTile !== nextTile) {
      previousTile.classList.remove("is-current");
      previousTile.removeAttribute("aria-current");
      previousTile.querySelector(".short-video-author-current-badge")?.remove();
    }
    if (nextTile?.isConnected) {
      nextTile.classList.add("is-current");
      nextTile.setAttribute("aria-current", "true");
      ensureAuthorCurrentBadge(nextTile);
    }
  }

  function syncRelatedPanelCurrentItem(panel = null) {
    const root = panel?.isConnected ? panel : els.workGrid?.querySelector?.(".short-video-author-panel");
    if (!root) return;
    const current = state.shortVideo?.current;
    for (const item of root.querySelectorAll(".short-video-related-item")) {
      const selected = isCurrentShortVideo({
        id: item.dataset.videoId || "",
        awemeId: item.dataset.awemeId || ""
      }, current);
      item.classList.toggle("is-current", selected);
      if (selected) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
      const existing = item.querySelector(".short-video-related-current");
      if (selected && !existing) {
        const badge = document.createElement("span");
        badge.className = "short-video-related-current";
        badge.textContent = "播放中";
        item.querySelector(".short-video-related-media")?.append(badge);
      } else if (!selected) {
        existing?.remove();
      }
    }
  }

  function ensureAuthorCurrentBadge(tile) {
    const media = tile?.querySelector?.(".short-video-author-tile-media");
    if (!media || media.querySelector(".short-video-author-current-badge")) return;
    const currentBadge = document.createElement("span");
    currentBadge.className = "short-video-author-current-badge";
    currentBadge.textContent = "当前观看";
    media.append(currentBadge);
  }

  function waitForVideoFirstFrame(player, timeout = 260) {
    if (!player) return Promise.resolve(false);
    if (player.readyState >= 2 && player.dataset.shortVideoFrameReady === "1") return Promise.resolve(true);
    const supportsPaintedFrame = typeof player.requestVideoFrameCallback === "function";
    if (player.readyState >= 2 && !supportsPaintedFrame) {
      player.dataset.shortVideoFrameReady = "1";
      player.dataset.shortVideoFrameReadyAt = String(Date.now());
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let finished = false;
      let frameHandle = null;
      let timeoutHandle = 0;
      const done = (ready) => {
        if (finished) return;
        finished = true;
        player.removeEventListener("loadeddata", onReady);
        player.removeEventListener("canplay", onReady);
        player.removeEventListener("playing", onReady);
        player.removeEventListener("error", onUnavailable);
        player.removeEventListener("emptied", onUnavailable);
        if (timeoutHandle) {
          window.clearTimeout(timeoutHandle);
          timeoutHandle = 0;
        }
        if (frameHandle != null && player.cancelVideoFrameCallback) {
          player.cancelVideoFrameCallback(frameHandle);
          frameHandle = null;
        }
        if (ready) {
          const firstPaintForPlayer = player.dataset.shortVideoFrameReady !== "1";
          player.dataset.shortVideoFrameReady = "1";
          player.dataset.shortVideoFrameReadyAt = String(Date.now());
          if (firstPaintForPlayer) {
            markShortVideoPerformance("video-frame-painted", {
              videoId: String(player.dataset.videoId || ""),
              slot: String(player.dataset.shortVideoSlot || "prewarm"),
              readyState: Number(player.readyState || 0),
              currentTime: Number(player.currentTime || 0),
              prewarmed: player.dataset.shortVideoPrewarmed === "1"
            });
          }
        }
        resolve(ready);
      };
      const requestPaintedFrame = () => {
        if (finished || player.readyState < 2 || !supportsPaintedFrame) return false;
        if (frameHandle != null) return true;
        frameHandle = player.requestVideoFrameCallback(() => done(true));
        return true;
      };
      const onReady = () => {
        if (supportsPaintedFrame) {
          requestPaintedFrame();
          return;
        }
        done(true);
      };
      const onUnavailable = () => done(false);
      player.addEventListener("loadeddata", onReady, { once: true });
      player.addEventListener("canplay", onReady, { once: true });
      player.addEventListener("playing", onReady, { once: true });
      player.addEventListener("error", onUnavailable, { once: true });
      player.addEventListener("emptied", onUnavailable, { once: true });
      requestPaintedFrame();
      timeoutHandle = window.setTimeout(() => {
        const readyWithoutFrameCallback = !supportsPaintedFrame && player.readyState >= 2;
        done(readyWithoutFrameCallback);
      }, timeout);
    });
  }

  function resumeActiveSound() {
    if (state.shortVideo.muted) return;
    window.requestAnimationFrame(() => {
      const player = activePlayer();
      if (!player) return;
      player.muted = false;
      player.volume = currentShortVideoVolume();
      player.play?.().catch(() => {
        markPlayerSoundBlocked(player.closest(".short-video-stage"));
        player.muted = true;
        player.play?.().catch(() => {});
      });
    });
  }

  function showHome() {
    shortVideoVisibilitySnapshot = null;
    shortVideoOpenRequestId += 1;
    shortVideoOpeningId = "";
    shortVideoOpenError = "";
    flushActiveShortVideoWatch();
    if (collectionsController.returnFromCollectionVideo()) return;
    if (authorPanelReturnFeed) {
      applyShortVideoFeedSnapshot(authorPanelReturnFeed);
      authorPanelReturnFeed = null;
    }
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    state.shortVideo.slideDirection = 0;
    state.shortVideo.loading = false;
    state.shortVideo.status = "";
    setBodyClass();
    renderStats();
    renderView();
    if (!state.shortVideo.data && !state.shortVideo.loading) {
      loadVideos({ replaceRoute: true }).catch(showError);
      return;
    }
    pushRoute({ view: "shortVideos", shortVideoId: "" });
  }
  function showShortVideoSearchOverlay(trigger = null) {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    const existing = browser.querySelector(".short-video-search-overlay");
    if (existing) {
      shortVideoSearch.focus(existing);
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = "short-video-search-overlay";
    overlay._shortVideoReturnFocus = trigger;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeShortVideoSearchOverlay(overlay);
    });

    const dialog = document.createElement("section");
    dialog.className = "short-video-search-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "搜索短视频");
    dialog.tabIndex = -1;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-search-dialog-close";
    close.setAttribute("aria-label", "关闭搜索，继续观看当前视频");
    close.append(createIcon("close"));
    close.addEventListener("click", () => closeShortVideoSearchOverlay(overlay));

    const search = shortVideoSearch.renderForm({
      value: "",
      placeholder: "搜索你感兴趣的内容",
      ariaLabel: "搜索短视频、作者或话题",
      onSubmit: (value) => {
        const query = String(value || "").trim();
        if (!query) {
          shortVideoSearch.focus(overlay);
          return;
        }
        closeShortVideoSearchOverlay(overlay, { restoreFocus: false });
        commitShortVideoSearch(query, { global: true, pushRoute: true });
      }
    });
    search.classList.add("short-video-search-dialog-form");

    dialog.append(close, search);
    overlay.append(dialog);
    browser.append(overlay);
    browser.classList.add("is-search-open");
    isolateShortVideoTransientModal(overlay);
    bindShortVideoModalFocusLoop(overlay, dialog, () => closeShortVideoSearchOverlay(overlay));
    shortVideoSearch.focus(overlay);
    window.requestAnimationFrame(() => shortVideoSearch.focus(overlay));
  }

  function closeShortVideoSearchOverlay(overlay, options = {}) {
    if (!overlay) return;
    const browser = overlay.closest?.(".short-video-browser");
    const returnFocus = overlay._shortVideoReturnFocus;
    restoreShortVideoTransientModalIsolation(overlay);
    overlay.remove();
    browser?.classList.remove("is-search-open");
    if (options.restoreFocus === false) return;
    if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
  }

  function installBrowseEvents() {
    if (eventsInstalled) return;
    eventsInstalled = true;
    window.addEventListener("wheel", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (isShortVideoOverlayTarget(event.target)) return;
      event.preventDefault();
      handleWheelSwipe(event.deltaY);
    }, { passive: false });
    window.addEventListener("scroll", () => {
      if (state.activeView !== "shortVideos" || state.shortVideo?.current) return;
      if (isShortVideoAuthorIndexPage()) {
        appendVisibleAuthorsIfNeeded();
        return;
      }
      if (!state.shortVideo?.data) return;
      scheduleShortVideoWindowUpdate();
    }, { passive: true });
    let resizeRaf = 0;
    window.addEventListener("resize", () => {
      if (state.activeView !== "shortVideos" || state.shortVideo?.current) return;
      if (resizeRaf) return;
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = 0;
        resizeShortVideoWindow();
      });
    });
    window.addEventListener("touchstart", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      touchControlInteraction = isShortVideoOverlayTarget(event.target) || isShortVideoKeyboardControl(event.target);
      if (touchControlInteraction) return;
      holdSpeedGestureConsumed = false;
      holdSpeedGestureBlockUntil = 0;
      const touch = event.touches?.[0];
      touchStartX = touch?.clientX || 0;
      touchStartY = touch?.clientY || 0;
      touchLastX = touchStartX;
      touchLastY = touchStartY;
      touchLastAt = Date.now();
      touchVelocityX = 0;
      touchVelocityY = 0;
      touchDeltaX = 0;
      touchDeltaY = 0;
      touchHorizontalDragging = false;
      state.shortVideo.dragging = true;
      activeReelStack()?.classList.add("is-dragging");
    }, { passive: true });
    window.addEventListener("touchmove", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (touchControlInteraction) return;
      if (isShortVideoOverlayTarget(event.target)) return;
      const touch = event.touches?.[0];
      const x = touch?.clientX || 0;
      const y = touch?.clientY || 0;
      const now = Date.now();
      const elapsed = Math.max(1, now - touchLastAt);
      const instantVelocityX = (x - touchLastX) / elapsed;
      const instantVelocityY = (y - touchLastY) / elapsed;
      touchVelocityX = touchVelocityX * .35 + instantVelocityX * .65;
      touchVelocityY = touchVelocityY * .35 + instantVelocityY * .65;
      touchLastX = x;
      touchLastY = y;
      touchLastAt = now;
      touchDeltaX = x - touchStartX;
      touchDeltaY = y - touchStartY;
      if (holdSpeedGestureConsumed) {
        touchDeltaX = 0;
        touchDeltaY = 0;
        touchVelocityX = 0;
        touchVelocityY = 0;
        event.preventDefault();
        return;
      }
      if (!touchHorizontalDragging && isHorizontalSwipe(touchDeltaX, touchDeltaY, 28)) {
        touchHorizontalDragging = true;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        startActiveGalleryDrag();
      }
      if (touchHorizontalDragging) updateActiveGalleryDrag(touchDeltaX);
      else scheduleReelDragDelta(touchDeltaY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener("touchend", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (touchControlInteraction) {
        touchControlInteraction = false;
        return;
      }
      if (holdSpeedGestureConsumed || Date.now() < holdSpeedGestureBlockUntil) {
        holdSpeedGestureConsumed = false;
        holdSpeedGestureBlockUntil = Date.now() + 120;
        state.shortVideo.dragging = false;
        touchHorizontalDragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        return;
      }
      if (isShortVideoOverlayTarget(event.target)) return;
      const touch = event.changedTouches?.[0];
      const endX = touch?.clientX || 0;
      const endY = touch?.clientY || 0;
      const deltaX = touchDeltaX || endX - touchStartX;
      const deltaY = touchDeltaY || endY - touchStartY;
      if (Math.hypot(deltaX, deltaY) > 8) {
        markShortVideoGestureClickBlocked(event.target);
      }
      if (Date.now() - touchLastAt > 80) {
        const velocityDecay = Math.max(0, 1 - (Date.now() - touchLastAt - 80) / 180);
        touchVelocityX *= velocityDecay;
        touchVelocityY *= velocityDecay;
      }
      if (touchHorizontalDragging) {
        state.shortVideo.dragging = false;
        touchHorizontalDragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        const handled = finishActiveGalleryDrag(deltaX, touchVelocityX);
        if (!handled && isHorizontalSwipe(deltaX, deltaY, 72)) handleHorizontalSwipe(deltaX);
        else if (!handled) finishDrag(0, 0);
        return;
      }
      finishDrag(deltaY, touchVelocityY);
    }, { passive: true });
    window.addEventListener("touchcancel", () => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (touchControlInteraction) {
        touchControlInteraction = false;
        return;
      }
      if (holdSpeedGestureConsumed || Date.now() < holdSpeedGestureBlockUntil) {
        holdSpeedGestureConsumed = false;
        holdSpeedGestureBlockUntil = Date.now() + 120;
        touchHorizontalDragging = false;
        state.shortVideo.dragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        return;
      }
      const wasHorizontal = touchHorizontalDragging;
      touchHorizontalDragging = false;
      state.shortVideo.dragging = false;
      activeReelStack()?.classList.remove("is-dragging");
      if (wasHorizontal) cancelActiveGalleryDrag();
      finishDrag(0, 0);
    }, { passive: true });
    window.addEventListener("pointerdown", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (event.pointerType === "touch") return;
      if (isShortVideoOverlayTarget(event.target)) return;
      if (event.button !== 0 || event.target?.closest?.("button, select, input, textarea, a")) return;
      holdSpeedGestureConsumed = false;
      holdSpeedGestureBlockUntil = 0;
      pointerStartX = event.clientX || 0;
      pointerStartY = event.clientY || 0;
      pointerLastX = pointerStartX;
      pointerLastY = pointerStartY;
      pointerLastAt = Date.now();
      pointerVelocityX = 0;
      pointerVelocityY = 0;
      pointerDeltaX = 0;
      pointerDeltaY = 0;
      pointerHorizontalDragging = false;
      pointerDragging = true;
      state.shortVideo.dragging = true;
      activeReelStack()?.classList.add("is-dragging");
    });
    window.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      if (!pointerDragging || state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      const x = event.clientX || 0;
      const y = event.clientY || 0;
      const now = Date.now();
      const elapsed = Math.max(1, now - pointerLastAt);
      const instantVelocityX = (x - pointerLastX) / elapsed;
      const instantVelocityY = (y - pointerLastY) / elapsed;
      pointerVelocityX = pointerVelocityX * .35 + instantVelocityX * .65;
      pointerVelocityY = pointerVelocityY * .35 + instantVelocityY * .65;
      pointerLastX = x;
      pointerLastY = y;
      pointerLastAt = now;
      pointerDeltaX = x - pointerStartX;
      pointerDeltaY = y - pointerStartY;
      if (holdSpeedGestureConsumed) {
        pointerDeltaX = 0;
        pointerDeltaY = 0;
        pointerVelocityX = 0;
        pointerVelocityY = 0;
        event.preventDefault();
        return;
      }
      if (!pointerHorizontalDragging && isHorizontalSwipe(pointerDeltaX, pointerDeltaY, 28)) {
        pointerHorizontalDragging = true;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        startActiveGalleryDrag();
      }
      if (pointerHorizontalDragging) updateActiveGalleryDrag(pointerDeltaX);
      else scheduleReelDragDelta(pointerDeltaY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch") return;
      if (!pointerDragging) return;
      pointerDragging = false;
      if (holdSpeedGestureConsumed || Date.now() < holdSpeedGestureBlockUntil) {
        holdSpeedGestureConsumed = false;
        holdSpeedGestureBlockUntil = Date.now() + 120;
        pointerHorizontalDragging = false;
        state.shortVideo.dragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        return;
      }
      if (Math.hypot(pointerDeltaX, pointerDeltaY) > 8) {
        markShortVideoGestureClickBlocked(event.target);
        suppressNextPlayerClick = true;
        window.setTimeout(() => {
          suppressNextPlayerClick = false;
        }, 240);
      }
      if (Date.now() - pointerLastAt > 80) {
        const velocityDecay = Math.max(0, 1 - (Date.now() - pointerLastAt - 80) / 180);
        pointerVelocityX *= velocityDecay;
        pointerVelocityY *= velocityDecay;
      }
      if (pointerHorizontalDragging) {
        state.shortVideo.dragging = false;
        pointerHorizontalDragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        const handled = finishActiveGalleryDrag(pointerDeltaX, pointerVelocityX);
        if (!handled && isHorizontalSwipe(pointerDeltaX, pointerDeltaY, 72)) handleHorizontalSwipe(pointerDeltaX);
        else if (!handled) finishDrag(0, 0);
        return;
      }
      finishDrag(pointerDeltaY, pointerVelocityY);
    });
    window.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "touch") return;
      if (!pointerDragging) return;
      pointerDragging = false;
      if (holdSpeedGestureConsumed || Date.now() < holdSpeedGestureBlockUntil) {
        holdSpeedGestureConsumed = false;
        holdSpeedGestureBlockUntil = Date.now() + 120;
        pointerHorizontalDragging = false;
        state.shortVideo.dragging = false;
        suppressNextPlayerClick = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        return;
      }
      const wasHorizontal = pointerHorizontalDragging;
      pointerHorizontalDragging = false;
      suppressNextPlayerClick = false;
      if (wasHorizontal) cancelActiveGalleryDrag();
      finishDrag(0, 0);
    });
    window.addEventListener("keydown", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      const playbackSettings = event.target?.closest?.(".short-video-more-overlay")
        || els.workGrid?.querySelector?.(".short-video-more-overlay");
      if (playbackSettings) {
        if (event.key === "Escape") {
          event.preventDefault();
          closePlaybackSettings(playbackSettings);
        }
        return;
      }
      if (isShortVideoKeyboardControl(event.target)) return;
      if (["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "PageDown", "PageUp", " ", "m", "M", "j", "J", "f", "F", "Escape"].includes(event.key)) {
        els.workGrid?.querySelector?.(".short-video-browser")?.shortVideoRevealControls?.(1900);
      }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && isGalleryPost(state.shortVideo.current)) {
        event.preventDefault();
        stepActiveGallery(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        seekActiveVideo(event.key === "ArrowLeft" ? -5 : 5);
      } else if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        openAdjacent(1).catch(showError);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        openAdjacent(-1).catch(showError);
      } else if (event.key === " ") {
        event.preventDefault();
        toggleActivePlayer();
      } else if (event.key?.toLowerCase?.() === "m") {
        event.preventDefault();
        toggleActiveMute().then((soundOn) => {
          showBrowserToast(soundOn ? "声音已开启" : "已静音");
        });
      } else if (event.key?.toLowerCase?.() === "j") {
        event.preventDefault();
        toggleClearScreen();
      } else if (event.key?.toLowerCase?.() === "f") {
        event.preventDefault();
        toggleShortVideoFullscreen();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (document.fullscreenElement) toggleShortVideoFullscreen();
        else closeOrRevealBrowser();
      }
    });
    document.addEventListener("visibilitychange", handleShortVideoVisibilityChange);
    document.addEventListener("fullscreenchange", syncShortVideoFullscreenControls);
    window.addEventListener("pagehide", flushActiveShortVideoWatch);
  }

  function handleShortVideoVisibilityChange() {
    if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
    const gallery = activeGalleryPlayer();
    const players = els.workGrid?.querySelectorAll?.(
      ".short-video-player, .short-video-gallery-image[data-gallery-media-type='video']"
    ) || [];
    if (document.hidden) {
      gallery?.shortVideoGalleryPause?.();
      const current = activePlayer();
      shortVideoVisibilitySnapshot = {
        videoId: current?.closest?.(".short-video-reel-panel")?.dataset?.videoId || "",
        wasPlaying: Boolean(current && !current.paused && !current.ended)
      };
      flushActiveShortVideoWatch();
      players.forEach((player) => {
        player.muted = true;
        player.pause?.();
      });
      els.workGrid?.querySelectorAll?.(".short-video-player.is-ghost")?.forEach?.((player) => {
        releaseOffscreenVideoDecoder(player, "document-hidden");
      });
      return;
    }
    gallery?.shortVideoGalleryResume?.();
    const resume = shortVideoVisibilitySnapshot;
    shortVideoVisibilitySnapshot = null;
    const current = activePlayer();
    if (!current) return;
    const currentVideoId = current.closest?.(".short-video-reel-panel")?.dataset?.videoId || "";
    if (!resume?.wasPlaying || resume.videoId !== currentVideoId) {
      current.muted = Boolean(state.shortVideo.muted);
      current.volume = currentShortVideoVolume();
      syncActiveControlBar();
      warmVisibleAdjacentVideoPlayers();
      return;
    }
    if (state.shortVideo.muted) {
      current.muted = true;
      current.play?.().catch(() => {});
      warmVisibleAdjacentVideoPlayers();
      return;
    }
    resumeActiveSound();
    warmVisibleAdjacentVideoPlayers();
  }

  function activePlayer() {
    const panel = els.workGrid?.querySelector?.(".short-video-reel-panel.is-current");
    return panel?.querySelector?.(".short-video-gallery-audio")
      || panel?.querySelector?.(".short-video-player:not(.is-ghost)")
      || null;
  }

  function closeTransientPlayerControls() {
    const volumeControl = els.workGrid?.querySelector?.(".short-video-control-volume");
    const hadVolumeFocus = Boolean(volumeControl?.contains?.(document.activeElement));
    if (typeof volumeControl?.shortVideoSetOpen === "function") volumeControl.shortVideoSetOpen(false);
    else {
      volumeControl?.classList.remove("is-open");
      volumeControl?.querySelector?.("button")?.setAttribute?.("aria-expanded", "false");
      const popover = volumeControl?.querySelector?.(".short-video-volume-popover");
      popover?.setAttribute?.("aria-hidden", "true");
      if (popover) popover.inert = true;
    }
    els.workGrid?.querySelector?.(".short-video-control-progress-wrap")?.classList.remove("is-hovering", "is-scrubbing");
    if (hadVolumeFocus) {
      activePlayer()?.closest?.(".short-video-stage")?.focus?.({ preventScroll: true });
    }
  }

  function syncActiveControlBar() {
    const bar = els.workGrid?.querySelector?.(".short-video-control-bar");
    bar?.shortVideoSync?.();
  }

  function activeGalleryPlayer() {
    return els.workGrid?.querySelector?.(".short-video-reel-panel.is-current .short-video-gallery-player") || null;
  }

  function stepActiveGallery(direction) {
    const gallery = activeGalleryPlayer();
    const count = Math.max(0, Number(gallery?.dataset?.galleryCount || 0));
    if (!gallery || count <= 1) return false;
    gallery.shortVideoGalleryMove?.(direction);
    return true;
  }

  function startActiveGalleryDrag() {
    return Boolean(activeGalleryPlayer()?.shortVideoGalleryDragStart?.());
  }

  function updateActiveGalleryDrag(deltaX) {
    return Boolean(activeGalleryPlayer()?.shortVideoGalleryDragMove?.(deltaX));
  }

  function finishActiveGalleryDrag(deltaX, velocityX = 0) {
    return Boolean(activeGalleryPlayer()?.shortVideoGalleryDragEnd?.(deltaX, velocityX));
  }

  function cancelActiveGalleryDrag() {
    return Boolean(activeGalleryPlayer()?.shortVideoGalleryDragCancel?.());
  }

  function isShortVideoKeyboardControl(target) {
    return Boolean(target?.closest?.("input, textarea, select, button, a, [contenteditable='true'], [role='button'], [role='tab'], [role='slider']"));
  }

  function markShortVideoGestureClickBlocked(target, durationMs = 420) {
    const browser = target?.closest?.(".short-video-browser")
      || els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    browser.dataset.shortVideoGestureBlockUntil = String(Date.now() + Math.max(120, Number(durationMs) || 420));
  }

  function isShortVideoGestureClickBlocked(target) {
    const browser = target?.closest?.(".short-video-browser")
      || els.workGrid?.querySelector?.(".short-video-browser");
    const blockedUntil = Number(browser?.dataset?.shortVideoGestureBlockUntil || 0);
    if (!blockedUntil) return false;
    if (Date.now() < blockedUntil) return true;
    delete browser.dataset.shortVideoGestureBlockUntil;
    return false;
  }

  function seekActiveVideo(deltaSeconds) {
    const player = activePlayer();
    if (!player) return false;
    const duration = Number(player.duration || 0);
    const current = Number(player.currentTime || 0);
    if (!duration || !Number.isFinite(current)) return false;
    const requestedDelta = Number(deltaSeconds || 0);
    const target = Math.max(0, Math.min(duration, current + requestedDelta));
    const actualDelta = target - current;
    player.currentTime = target;
    syncActiveControlBar();
    showKeyboardSeekFeedback(player.closest(".short-video-stage"), requestedDelta, actualDelta, target, duration);
    return true;
  }

  function showKeyboardSeekFeedback(stage, requestedDelta, actualDelta, target, duration) {
    if (!stage) return;
    stage.querySelector(".short-video-keyboard-seek-feedback")?.remove();
    const feedback = document.createElement("div");
    feedback.className = `short-video-keyboard-seek-feedback${requestedDelta > 0 ? " is-forward" : " is-backward"}`;
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    const icon = createIcon("chevronLeft");
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    if (Math.abs(actualDelta) < .1) label.textContent = requestedDelta > 0 ? "已到结尾" : "已到开头";
    else label.textContent = requestedDelta > 0 ? "快进 5 秒" : "快退 5 秒";
    const position = document.createElement("small");
    position.textContent = `${formatSeconds(target)} / ${formatSeconds(duration)}`;
    copy.append(label, position);
    feedback.append(icon, copy);
    stage.append(feedback);
    window.setTimeout(() => feedback.remove(), 820);
  }

  function toggleActivePlayer() {
    const gallery = activeGalleryPlayer();
    if (gallery && isGalleryPost(state.shortVideo?.current)) {
      gallery.shortVideoGalleryTogglePlayback?.();
      syncActiveControlBar();
      return;
    }
    const player = activePlayer();
    if (!player) return;
    if (player.paused) player.play().catch(() => {}).finally(syncActiveControlBar);
    else {
      player.pause();
      syncActiveControlBar();
    }
    clearPlayerSoundBlocked(player.closest(".short-video-stage"));
  }

  function currentShortVideoVolume() {
    return normalizeShortVideoVolume(state.shortVideo?.volume ?? readVolumePreference());
  }

  function setActiveShortVideoVolume(percent) {
    const player = activePlayer();
    if (!player) return;
    const wasPlaying = !player.paused && !player.ended;
    const rawPercent = Math.max(0, Math.min(100, Number(percent || 0)));
    if (rawPercent <= 0) {
      player.muted = true;
      state.shortVideo.muted = true;
      writeMutedPreference(true);
    } else {
      const volume = normalizeShortVideoVolume(rawPercent / 100);
      state.shortVideo.volume = volume;
      state.shortVideo.muted = false;
      writeVolumePreference(volume);
      writeMutedPreference(false);
      player.volume = volume;
      player.muted = false;
      if (wasPlaying) player.play?.().catch(() => {});
    }
    clearPlayerSoundBlocked(player.closest(".short-video-stage"));
  }

  async function toggleActiveMute() {
    const player = activePlayer();
    if (!player) return false;
    const stage = player.closest(".short-video-stage");
    const wasPlaying = !player.paused && !player.ended;
    player.muted = !player.muted;
    if (!player.muted) player.volume = currentShortVideoVolume();
    state.shortVideo.muted = player.muted;
    writeMutedPreference(player.muted);
    clearPlayerSoundBlocked(stage);
    if (wasPlaying && !player.muted) {
      try {
        await player.play?.();
      } catch {
        if (!player.paused) {
          clearPlayerSoundBlocked(stage);
          syncActiveControlBar();
          return true;
        }
        player.muted = true;
        state.shortVideo.muted = true;
        writeMutedPreference(true);
        markPlayerSoundBlocked(stage);
        player.play?.().catch(() => {});
        syncActiveControlBar();
      }
    }
    syncActiveControlBar();
    return !player.muted;
  }

  function toggleClearScreen() {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    closeTransientPlayerControls();
    const cleared = browser.classList.toggle("is-clear-screen");
    delete browser.dataset.shortVideoClearScreenRevealAt;
    syncActiveControlBar();
    if (cleared) {
      const touchPrimary = window.matchMedia?.("(pointer: coarse)")?.matches
        || window.matchMedia?.("(max-width: 680px)")?.matches;
      showBrowserToast(touchPrimary ? "轻触画面恢复操作界面" : "按 J 或 Esc 恢复操作界面");
      return;
    }
    browser.shortVideoRevealControls?.(1900);
    showBrowserToast("已恢复操作界面");
  }

  function revealShortVideoClearScreen(target) {
    const browser = target?.closest?.(".short-video-browser");
    if (!browser?.classList.contains("is-clear-screen")) return false;
    browser.classList.remove("is-clear-screen");
    browser.dataset.shortVideoClearScreenRevealAt = String(Date.now());
    browser.shortVideoRevealControls?.(1900);
    syncActiveControlBar();
    showBrowserToast("已恢复操作界面");
    return true;
  }

  function wasClearScreenJustRevealed(target) {
    const browser = target?.closest?.(".short-video-browser");
    const revealedAt = Number(browser?.dataset?.shortVideoClearScreenRevealAt || 0);
    if (!revealedAt) return false;
    if (Date.now() - revealedAt <= SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS + 120) return true;
    delete browser.dataset.shortVideoClearScreenRevealAt;
    return false;
  }

  function closeOrRevealBrowser() {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    const playbackSettings = browser?.querySelector?.(".short-video-more-overlay");
    if (playbackSettings) {
      closePlaybackSettings(playbackSettings);
      return;
    }
    const authorPanel = browser?.querySelector?.(".short-video-author-panel");
    if (authorPanel) {
      closeAuthorPanel(authorPanel);
      return;
    }
    if (browser?.classList.contains("is-clear-screen")) {
      browser.classList.remove("is-clear-screen");
      browser.shortVideoRevealControls?.(1900);
      showBrowserToast("已恢复操作界面");
      return;
    }
    showHome();
  }

  function isShortVideoOverlayTarget(target) {
    return Boolean(target?.closest?.(".short-video-search-overlay, .short-video-author-sheet, .short-video-share-panel, .short-video-more-overlay"));
  }

  function showHeartBurst(stage, event) {
    const heart = document.createElement("span");
    heart.className = "short-video-heart-burst";
    heart.append(createIcon("heart"));
    const rect = stage.getBoundingClientRect();
    heart.style.left = `${Math.max(28, Math.min(rect.width - 28, (event.clientX || rect.left + rect.width / 2) - rect.left))}px`;
    heart.style.top = `${Math.max(28, Math.min(rect.height - 28, (event.clientY || rect.top + rect.height / 2) - rect.top))}px`;
    stage.append(heart);
    heart.addEventListener("animationend", () => heart.remove(), { once: true });
  }

  function scheduleAdjacentNavigationPrefetch() {
    if (state.shortVideo.mode === "collection") return;
    window.clearTimeout(shortVideoNavigationPrefetchTimer);
    const params = shortVideoFeedParams();
    const forward = { direction: 1, video: state.shortVideo?.nextVideo };
    const backward = { direction: -1, video: state.shortVideo?.prevVideo };
    // Match navigation look-ahead to the one media decoder we keep warm. The
    // opposite visible neighbor can already be promoted immediately; fetching
    // its second ring on every page doubles detail parsing during fast swipes.
    const preferred = shortVideoAdjacentWarmDirection < 0 ? backward : forward;
    const fallback = shortVideoAdjacentWarmDirection < 0 ? forward : backward;
    const candidate = preferred.video?.id ? preferred : (fallback.video?.id ? fallback : null);
    if (!candidate) return;
    const currentVideoId = String(state.shortVideo?.current?.id || "");
    const scheduledAt = Date.now();
    const run = () => {
      shortVideoNavigationPrefetchTimer = 0;
      if (!currentVideoId || String(state.shortVideo?.current?.id || "") !== currentVideoId) return;
      const current = activePlayer();
      const elapsed = Date.now() - scheduledAt;
      if (current && current.dataset.shortVideoFrameReady !== "1" && elapsed < SHORT_VIDEO_NAV_PREFETCH_MAX_WAIT_MS) {
        shortVideoNavigationPrefetchTimer = window.setTimeout(run, 120);
        return;
      }
      const frameReadyAt = Number(current?.dataset?.shortVideoFrameReadyAt || 0);
      const cooldown = frameReadyAt
        ? SHORT_VIDEO_NAV_PREFETCH_AFTER_FRAME_MS - (Date.now() - frameReadyAt)
        : 0;
      if (cooldown > 0) {
        shortVideoNavigationPrefetchTimer = window.setTimeout(run, cooldown);
        return;
      }
      markShortVideoPerformance("adjacent-navigation-prefetch-start", {
        videoId: String(candidate.video?.id || ""),
        currentVideoId,
        direction: candidate.direction,
        deferredMs: Date.now() - scheduledAt,
        currentFrameReady: current?.dataset?.shortVideoFrameReady === "1"
      });
      prefetchAdjacentNavigation(candidate.video, candidate.direction, params).catch(() => {});
    };
    shortVideoNavigationPrefetchTimer = window.setTimeout(run, 60);
  }

  async function prefetchAdjacentNavigation(video, direction, params) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return;
    rememberShortVideo(video);
    const detail = await fetchShortVideoDetail(videoId, params);
    const farId = String(direction > 0 ? detail?.nextId || "" : detail?.prevId || "").trim();
    if (!farId || cachedShortVideo(farId) || shortVideoVideoPrefetches.has(farId)) return;
    const request = api(`/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=${direction > 0 ? "next" : "prev"}&${params}`)
      .then((data) => rememberShortVideo(data?.video))
      .finally(() => shortVideoVideoPrefetches.delete(farId));
    shortVideoVideoPrefetches.set(farId, request);
    await request;
  }

  async function loadAdjacentVideos(videoId) {
    const requestId = ++shortVideoAdjacentRequestId;
    if (state.shortVideo.mode === "collection") await collectionsController.prepareCollectionNavigation(videoId).catch(() => {});
    if (requestId !== shortVideoAdjacentRequestId || state.shortVideo.current?.id !== videoId) return false;
    const prevId = state.shortVideo.prevId;
    const nextId = state.shortVideo.nextId;
    const params = shortVideoFeedParams();
    const collectionNavigation = collectionsController.collectionNavigation(videoId);
    const knownPrev = collectionNavigation?.prevVideo || (String(state.shortVideo.prevVideo?.id || "") === String(prevId || "")
      ? state.shortVideo.prevVideo
      : cachedShortVideo(prevId));
    const knownNext = collectionNavigation?.nextVideo || (String(state.shortVideo.nextVideo?.id || "") === String(nextId || "")
      ? state.shortVideo.nextVideo
      : cachedShortVideo(nextId));
    const loadAdjacent = (id, known, direction) => {
      if (!id) return Promise.resolve(null);
      if (known) return Promise.resolve({ video: known });
      const prefetched = shortVideoVideoPrefetches.get(String(id));
      if (prefetched) {
        return prefetched
          .then((video) => video ? { video } : null)
          .catch(() => api(`/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=${direction}&${params}`));
      }
      return api(`/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=${direction}&${params}`);
    };
    const [prevResult, nextResult] = await Promise.allSettled([
      loadAdjacent(prevId, knownPrev, "prev"),
      loadAdjacent(nextId, knownNext, "next")
    ]);
    if (requestId !== shortVideoAdjacentRequestId || state.shortVideo.current?.id !== videoId) return false;
    state.shortVideo.prevVideo = prevResult.status === "fulfilled" ? prevResult.value?.video || null : null;
    state.shortVideo.nextVideo = nextResult.status === "fulfilled" ? nextResult.value?.video || null : null;
    rememberShortVideo(state.shortVideo.prevVideo);
    rememberShortVideo(state.shortVideo.nextVideo);
    cacheAuthorPanelVideo(state.shortVideo.prevVideo);
    cacheAuthorPanelVideo(state.shortVideo.nextVideo);
    scheduleAdjacentNavigationPrefetch();
    return true;
  }

  function shortVideoFeedParams() {
    const params = new URLSearchParams();
    if (state.shortVideo.query) params.set("q", state.shortVideo.query);
    if (state.shortVideo.topic) params.set("topic", state.shortVideo.topic);
    if (state.shortVideo.sound) params.set("sound", state.shortVideo.sound);
    if (state.shortVideo.author && state.shortVideo.author !== "all") params.set("author", state.shortVideo.author);
    if (state.shortVideo.media && state.shortVideo.media !== "all") params.set("media", state.shortVideo.media);
    if (state.shortVideo.quality && state.shortVideo.quality !== "all") params.set("quality", state.shortVideo.quality);
    params.set("source", shortVideoApiSource());
    params.set("sort", state.shortVideo.sort || "published");
    return params.toString();
  }

  function activeReelStack() {
    return els.workGrid?.querySelector?.(".short-video-reel-stack") || null;
  }

  function isHorizontalSwipe(deltaX, deltaY, threshold) {
    return Math.abs(deltaX) >= threshold && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
  }

  function handleHorizontalSwipe(deltaX) {
    if (isGalleryPost(state.shortVideo?.current) && stepActiveGallery(deltaX < 0 ? 1 : -1)) return;
    if (deltaX < 0) {
      closeOrRevealBrowser();
      return;
    }
    if (isViewingAuthorFeed()) return;
    openShortVideoAuthorPage(state.shortVideo?.current?.author, state.shortVideo?.current);
  }

  function isViewingAuthorFeed() {
    return Boolean(state.shortVideo?.author && state.shortVideo.author !== "all");
  }

  function applyDragDelta(deltaY) {
    const hasTarget = deltaY < 0 ? Boolean(state.shortVideo.nextId) : Boolean(state.shortVideo.prevId);
    const stack = activeReelStack();
    if (!stack) return;
    clearBoundaryPulse(stack);
    window.clearTimeout(reelBoundaryResetTimer);
    reelBoundaryResetTimer = 0;
    stack.classList.remove("is-boundary-rebounding");
    stack.classList.toggle("is-boundary-start", !hasTarget && deltaY > 0);
    stack.classList.toggle("is-boundary-end", !hasTarget && deltaY < 0);
    const distance = Math.abs(deltaY);
    const resistedDistance = distance * SHORT_VIDEO_BOUNDARY_RESISTANCE / (1 + distance / SHORT_VIDEO_BOUNDARY_RANGE);
    const damped = hasTarget ? deltaY : Math.sign(deltaY) * resistedDistance;
    stack.style.setProperty("--short-video-drag-y", `${damped}px`);
  }

  function scheduleReelDragDelta(deltaY) {
    reelDragDeltaY = deltaY;
    if (reelDragRaf) return;
    reelDragRaf = window.requestAnimationFrame(() => {
      reelDragRaf = 0;
      applyDragDelta(reelDragDeltaY);
    });
  }

  function flushReelDragDelta() {
    if (reelDragRaf) window.cancelAnimationFrame(reelDragRaf);
    reelDragRaf = 0;
    applyDragDelta(reelDragDeltaY);
  }

  function cancelReelDragDelta() {
    if (reelDragRaf) window.cancelAnimationFrame(reelDragRaf);
    reelDragRaf = 0;
    reelDragDeltaY = 0;
  }

  function handleWheelSwipe(deltaY) {
    const now = Date.now();
    if (Math.abs(deltaY) < 2) return;
    const previousWheelAt = wheelLastAt;
    wheelLastAt = now;
    const gestureAge = wheelGestureStartedAt ? now - wheelGestureStartedAt : 0;
    const isExplicitNewGesture = Math.abs(deltaY) >= 70
      && (now - previousWheelAt >= WHEEL_NEW_GESTURE_GAP_MS || gestureAge >= 400);
    if (wheelLocked && now >= wheelIgnoreUntil && isExplicitNewGesture) {
      queuedAdjacentDirection = deltaY > 0 ? 1 : -1;
      wheelGestureConsumed = true;
      wheelGestureStartedAt = now;
      scheduleWheelGestureRelease();
      return;
    }
    const startsExplicitNewGesture = wheelGestureConsumed
      && !wheelLocked
      && now >= wheelIgnoreUntil
      && isExplicitNewGesture;
    if (startsExplicitNewGesture) {
      wheelGestureConsumed = false;
      wheelDeltaY = 0;
    }
    if (wheelLocked || wheelGestureConsumed || now < wheelIgnoreUntil) {
      wheelGestureConsumed = true;
      wheelDeltaY = 0;
      cancelReelDragDelta();
      scheduleWheelGestureRelease();
      return;
    }
    if (now - previousWheelAt > 260 || Math.sign(wheelDeltaY) !== Math.sign(deltaY)) {
      wheelDeltaY = 0;
    }
    wheelDeltaY = Math.max(-180, Math.min(180, wheelDeltaY + deltaY));
    const visualDelta = wheelDeltaY * -0.55;
    activeReelStack()?.classList.add("is-dragging");
    scheduleReelDragDelta(visualDelta);
    window.clearTimeout(wheelResetTimer);
    wheelResetTimer = window.setTimeout(() => {
      wheelDeltaY = 0;
      snapStackBack();
    }, 160);
    if (Math.abs(wheelDeltaY) < SHORT_VIDEO_WHEEL_DISTANCE) return;
    const direction = wheelDeltaY > 0 ? 1 : -1;
    const wheelMotion = {
      dragDistance: Math.abs(visualDelta),
      velocity: Math.min(1.4, Math.abs(deltaY) / 80)
    };
    wheelDeltaY = 0;
    wheelGestureConsumed = true;
    wheelGestureStartedAt = now;
    flushReelDragDelta();
    scheduleWheelGestureRelease();
    activeReelStack()?.classList.remove("is-dragging");
    openAdjacent(direction, { motion: wheelMotion }).catch(showError);
  }

  function scheduleWheelGestureRelease() {
    window.clearTimeout(wheelResetTimer);
    if (!wheelGestureConsumed) return;
    const idleFor = Date.now() - wheelLastAt;
    if (!wheelLocked && idleFor >= WHEEL_GESTURE_IDLE_MS) {
      wheelGestureConsumed = false;
      wheelGestureStartedAt = 0;
      wheelDeltaY = 0;
      snapStackBack();
      return;
    }
    const delay = Math.max(16, WHEEL_GESTURE_IDLE_MS - idleFor);
    wheelResetTimer = window.setTimeout(() => {
      if (wheelLocked) return;
      const remaining = WHEEL_GESTURE_IDLE_MS - (Date.now() - wheelLastAt);
      if (remaining > 0) {
        scheduleWheelGestureRelease();
        return;
      }
      wheelGestureConsumed = false;
      wheelGestureStartedAt = 0;
      wheelDeltaY = 0;
      snapStackBack();
    }, delay);
  }

  function finishDrag(deltaY, velocityY = 0) {
    flushReelDragDelta();
    const fastFlick = Math.abs(deltaY) >= 18 && Math.abs(velocityY) >= .32;
    const directionSignal = Math.abs(deltaY) >= 18 ? deltaY : velocityY * 80;
    const direction = directionSignal < 0 ? 1 : -1;
    state.shortVideo.dragging = false;
    activeReelStack()?.classList.remove("is-dragging");
    if ((!fastFlick && Math.abs(deltaY) < SHORT_VIDEO_SWIPE_DISTANCE) || (direction > 0 && !state.shortVideo.nextId) || (direction < 0 && !state.shortVideo.prevId)) {
      snapStackBack();
      return;
    }
    openAdjacent(direction, {
      motion: {
        dragDistance: Math.abs(deltaY),
        velocity: Math.abs(velocityY)
      }
    }).catch(showError);
  }

  function snapStackBack() {
    cancelReelDragDelta();
    const stack = activeReelStack();
    if (!stack) return;
    clearBoundaryPulse(stack);
    window.clearTimeout(reelBoundaryResetTimer);
    reelBoundaryResetTimer = 0;
    const boundaryRebound = stack.classList.contains("is-boundary-start") || stack.classList.contains("is-boundary-end");
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev", "is-rebasing", "is-boundary-start", "is-boundary-end");
    stack.classList.toggle("is-boundary-rebounding", boundaryRebound);
    stack.style.setProperty("--short-video-drag-y", "0px");
    if (boundaryRebound) {
      reelBoundaryResetTimer = window.setTimeout(() => {
        reelBoundaryResetTimer = 0;
        stack.classList.remove("is-boundary-rebounding");
      }, 360);
    }
  }

  function clearBoundaryPulse(stack = activeReelStack()) {
    if (reelBoundaryPulseRaf) window.cancelAnimationFrame(reelBoundaryPulseRaf);
    if (reelBoundaryPulseTimer) window.clearTimeout(reelBoundaryPulseTimer);
    reelBoundaryPulseRaf = 0;
    reelBoundaryPulseTimer = 0;
    stack?.classList.remove("is-boundary-pulse-start", "is-boundary-pulse-end");
  }

  function pulseBoundaryStack(direction) {
    cancelReelDragDelta();
    const stack = activeReelStack();
    if (!stack) return;
    clearBoundaryPulse(stack);
    window.clearTimeout(reelBoundaryResetTimer);
    reelBoundaryResetTimer = 0;
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev", "is-rebasing", "is-boundary-start", "is-boundary-end", "is-boundary-rebounding");
    stack.style.setProperty("--short-video-drag-y", "0px");
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    reelBoundaryPulseRaf = window.requestAnimationFrame(() => {
      reelBoundaryPulseRaf = 0;
      const className = direction < 0 ? "is-boundary-pulse-start" : "is-boundary-pulse-end";
      stack.classList.add(className);
      reelBoundaryPulseTimer = window.setTimeout(() => {
        reelBoundaryPulseTimer = 0;
        stack.classList.remove(className);
      }, 340);
    });
  }

  function resolveSwitchAnimationDuration(motion = {}) {
    const dragDistance = Math.max(0, Number(motion?.dragDistance || 0));
    const velocity = Math.max(0, Number(motion?.velocity || 0));
    if (!dragDistance && !velocity) {
      return motion?.prewarmed ? SHORT_VIDEO_PREWARMED_SWITCH_ANIMATION_MS : SHORT_VIDEO_SWITCH_ANIMATION_MS;
    }
    const viewportHeight = Math.max(1, Number(window.innerHeight || 720));
    const remainingRatio = 1 - Math.min(1, dragDistance / viewportHeight);
    const velocityRatio = Math.min(1, velocity / 1.4);
    const duration = SHORT_VIDEO_SWITCH_MIN_ANIMATION_MS
      + remainingRatio * (SHORT_VIDEO_SWITCH_ANIMATION_MS - SHORT_VIDEO_SWITCH_MIN_ANIMATION_MS)
      - velocityRatio * 28;
    return Math.round(Math.max(
      SHORT_VIDEO_SWITCH_MIN_ANIMATION_MS,
      Math.min(SHORT_VIDEO_SWITCH_MAX_ANIMATION_MS, duration)
    ));
  }

  function animateActiveStack(direction, motion = {}) {
    const stack = activeReelStack();
    if (!stack) return Promise.resolve();
    const duration = resolveSwitchAnimationDuration(motion);
    clearBoundaryPulse(stack);
    window.clearTimeout(reelBoundaryResetTimer);
    reelBoundaryResetTimer = 0;
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev", "is-boundary-start", "is-boundary-end", "is-boundary-rebounding");
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      stack.classList.add(direction > 0 ? "is-snap-next" : "is-snap-prev");
      stack.style.setProperty("--short-video-drag-y", "0px");
      return Promise.resolve();
    }
    stack.style.setProperty("--short-video-switch-duration", `${duration}ms`);
    return new Promise((resolve) => {
      let done = false;
      let animationFrame = 0;
      let timeoutHandle = 0;
      const finish = () => {
        if (done) return;
        done = true;
        if (animationFrame) window.cancelAnimationFrame(animationFrame);
        if (timeoutHandle) window.clearTimeout(timeoutHandle);
        stack.removeEventListener("transitionend", handleTransitionEnd);
        stack.style.removeProperty("--short-video-switch-duration");
        resolve();
      };
      const handleTransitionEnd = (event) => {
        if (event.propertyName !== "transform") return;
        finish();
      };
      stack.addEventListener("transitionend", handleTransitionEnd);
      timeoutHandle = window.setTimeout(finish, duration + 70);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        if (done) return;
        stack.classList.add(direction > 0 ? "is-snap-next" : "is-snap-prev");
        stack.style.setProperty("--short-video-drag-y", "0px");
      });
    });
  }

  function bindShortVideoModalFocusLoop(overlay, sheet, closeModal) {
    if (!overlay || !sheet) return;
    const focusableSelector = [
      "button:not([disabled])",
      "a[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "summary",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const focusableItems = () => [...sheet.querySelectorAll(focusableSelector)].filter((element) => (
      !element.hidden
      && element.getAttribute("aria-hidden") !== "true"
      && element.getClientRects().length > 0
    ));
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeModal?.();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableItems();
      if (!items.length) {
        event.preventDefault();
        sheet.focus?.({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !sheet.contains(active))) {
        event.preventDefault();
        last.focus?.({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !sheet.contains(active))) {
        event.preventDefault();
        first.focus?.({ preventScroll: true });
      }
    });
  }

  function isolateShortVideoTransientModal(overlay) {
    const browser = overlay?.parentElement;
    if (!overlay || !browser) return;
    const gallery = activeGalleryPlayer();
    if (gallery) {
      overlay._shortVideoPausedGallery = gallery;
      gallery.shortVideoGalleryPause?.("modal");
    }
    overlay._shortVideoModalSiblings = [...browser.children]
      .filter((element) => element !== overlay)
      .map((element) => ({ element, wasInert: element.hasAttribute("inert") }));
    for (const item of overlay._shortVideoModalSiblings) item.element.setAttribute("inert", "");
  }

  function restoreShortVideoTransientModalIsolation(overlay) {
    for (const item of overlay?._shortVideoModalSiblings || []) {
      if (!item.wasInert && item.element?.isConnected) item.element.removeAttribute("inert");
    }
    const gallery = overlay?._shortVideoPausedGallery;
    if (gallery?.isConnected) gallery.shortVideoGalleryResume?.("modal");
    if (overlay) overlay._shortVideoPausedGallery = null;
    overlay._shortVideoModalSiblings = null;
  }

  function focusShortVideoTransientModal(sheet, target) {
    const focusTarget = () => {
      if (!sheet?.isConnected || !target?.isConnected || sheet.contains(document.activeElement)) return;
      target.focus?.({ preventScroll: true });
    };
    focusTarget();
    window.requestAnimationFrame(() => window.requestAnimationFrame(focusTarget));
  }

  function ensureShortVideoPlaybackSettings() {
    if (shortVideoPlaybackSettingsPromise) return shortVideoPlaybackSettingsPromise;
    const moduleUrl = "/modules/short-videos/playback-settings.js?v=20260824-local-file-actions-01";
    shortVideoPlaybackSettingsPromise = import(moduleUrl).then((module) => {
      if (typeof module.createShortVideoPlaybackSettings !== "function") {
        throw new Error("播放设置模块加载失败");
      }
      return module.createShortVideoPlaybackSettings({
        activePlayer,
        bindShortVideoModalFocusLoop,
        closePlaybackSettings,
        createIcon,
        deleteShortVideo,
        focusShortVideoTransientModal,
        formatPlaybackRate,
        getBrowser: () => els.workGrid?.querySelector?.(".short-video-browser"),
        getWorkGrid: () => els.workGrid,
        isCurrentShortVideo,
        isGalleryPost,
        isolateShortVideoTransientModal,
        loadVideos,
        normalizePlaybackRate,
        openAdjacent,
        openDouyinLink,
        originalDouyinUrl, runShortVideoLocalAction,
        playbackRates: PLAYBACK_RATES,
        setPlaybackRate,
        shareShortVideo,
        showBrowserToast,
        showError,
        state,
        syncActivePlaybackMode,
        syncShortVideoFullscreenControl,
        toggleClearScreen,
        toggleShortVideoDislike,
        toggleShortVideoFullscreen,
        writeAutoNextPreference
      });
    }).catch((error) => {
      shortVideoPlaybackSettingsPromise = null;
      throw error;
    });
    return shortVideoPlaybackSettingsPromise;
  }

  function scheduleShortVideoPlaybackSettingsWarmup() {
    if (shortVideoPlaybackSettingsPromise || shortVideoPlaybackSettingsWarmupScheduled) return;
    shortVideoPlaybackSettingsWarmupScheduled = true;
    const warm = () => {
      if (shortVideoPlaybackSettingsPromise) return;
      markShortVideoPerformance("playback-settings-warm-start");
      ensureShortVideoPlaybackSettings()
        .then(() => markShortVideoPerformance("playback-settings-warm-ready"))
        .catch((error) => {
          shortVideoPlaybackSettingsWarmupScheduled = false;
          markShortVideoPerformance("playback-settings-warm-error", {
            message: String(error?.message || error || "unknown")
          });
        });
    };
    window.setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(warm, { timeout: 700 });
      } else {
        warm();
      }
    }, 180);
  }

  function showPlaybackSettings(video = state.shortVideo?.current, options = {}) {
    const trigger = options.trigger;
    trigger?.setAttribute?.("aria-busy", "true");
    return ensureShortVideoPlaybackSettings()
      .then((showSettings) => showSettings(video, options))
      .catch((error) => showBrowserToast(error?.message || "播放设置模块加载失败"))
      .finally(() => trigger?.removeAttribute?.("aria-busy"));
  }

  function closePlaybackSettings(overlay, options = {}) {
    if (!overlay) return;
    const returnFocus = overlay._shortVideoReturnFocus;
    restoreShortVideoTransientModalIsolation(overlay);
    overlay.remove();
    if (options.restoreFocus === false) return;
    if (returnFocus?.isConnected) {
      returnFocus.focus?.({ preventScroll: true });
      window.requestAnimationFrame(() => {
        if (document.activeElement !== returnFocus && returnFocus.isConnected) {
          returnFocus.focus?.({ preventScroll: true });
        }
      });
    }
  }

  function setPlaybackRate(value) {
    const rate = normalizePlaybackRate(value);
    state.shortVideo.playbackRate = rate;
    writePlaybackRatePreference(rate);
    const players = els.workGrid?.querySelectorAll?.(
      ".short-video-player, .short-video-gallery-image[data-gallery-media-type='video']"
    ) || [];
    players.forEach((player) => {
      player.playbackRate = rate;
    });
    const controlRate = els.workGrid?.querySelector?.(".short-video-control-rate");
    if (controlRate) controlRate.textContent = formatPlaybackRate(rate);
    showBrowserToast(`已切换到 ${formatPlaybackRate(rate)}`);
  }

  async function deleteShortVideo(video, options = {}) {
    if (!video?.id) return;
    const scope = options.scope === "group" ? "group" : "single";
    const deletingCurrent = state.shortVideo?.current?.id === video.id;
    const nextId = deletingCurrent ? state.shortVideo.nextId || "" : "";
    const prevId = deletingCurrent ? state.shortVideo.prevId || "" : "";
    const data = await deleteActions.deleteVideo(video, { scope });
    if (!data?.committed) return;
    const deletedIds = new Set(data.ids);
    for (const id of deletedIds) loadedCoverIds.delete(id);
    if (state.shortVideo.data?.videos) {
      state.shortVideo.data.videos = state.shortVideo.data.videos.filter((item) => !deletedIds.has(String(item.id || "")));
      state.shortVideo.data.total = Math.max(0, Number(state.shortVideo.data.total || 0) - deletedIds.size);
    }
    decrementCurrentAuthorCount(deletedIds.size);
    const message = data.pending ? shortVideoDeletePendingMessage(data) : shortVideoDeleteCompletedMessage(data, { scope });
    if (deletingCurrent) {
      showBrowserToast(message);
      const fallbackId = [nextId, prevId].find((id) => id && !deletedIds.has(String(id)));
      if (fallbackId) {
        await openVideo(fallbackId);
      } else {
        state.shortVideo.data = null;
        showHome();
      }
      return;
    }
    state.shortVideo.data = null;
    await loadVideos({ replaceRoute: true });
    if (options.fromBrowser || scope === "group") showBrowserToast(message);
  }

  async function deleteSelectedShortVideos() {
    const selection = shortVideoDeleteSelection();
    const ids = [...selection].filter(Boolean);
    const data = await deleteActions.deleteSelected(ids);
    if (!data?.committed) return;
    const deletedIds = new Set(data.ids);
    for (const id of deletedIds) loadedCoverIds.delete(id);
    if (state.shortVideo.data?.videos) {
      state.shortVideo.data.videos = state.shortVideo.data.videos.filter((item) => !deletedIds.has(String(item.id || "")));
      state.shortVideo.data.total = Math.max(0, Number(state.shortVideo.data.total || 0) - deletedIds.size);
    }
    decrementCurrentAuthorCount(deletedIds.size);
    clearShortVideoDeleteSelection();
    state.shortVideo.data = null;
    await loadVideos({ replaceRoute: true });
    showBrowserToast(data.pending ? shortVideoDeletePendingMessage(data) : shortVideoDeleteCompletedMessage(data));
  }

  function decrementCurrentAuthorCount(value) {
    if (!isShortVideoAuthorDetailPage()) return;
    const amount = Math.max(0, Number(value) || 0);
    if (!amount) return;
    const filter = String(state.shortVideo.author || "").trim();
    const facet = (state.shortVideo.authors || []).find((author) => shortVideoAuthorFilterValue(author) === filter);
    if (facet) facet.count = Math.max(0, Number(facet.count || 0) - amount);
  }

  function showBrowserToast(message) {
    const browser = els.workGrid?.querySelector?.(".short-video-browser, .short-video-home");
    if (!browser) return;
    browser.querySelector(".short-video-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "short-video-toast";
    toast.textContent = message;
    browser.append(toast);
    window.setTimeout(() => toast.remove(), 1500);
  }

  function railNav(icon, action, disabled) {
    const button = railButton("", createIcon(icon === "↑" ? "chevronUp" : "chevronDown"), "nav", icon === "↑" ? "上一个" : "下一个");
    button.title = icon === "↑" ? "上一个（↑）" : "下一个（↓）";
    button.disabled = disabled;
    button.addEventListener("click", action);
    return button;
  }

  function authorCaptionButton(video) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-caption-author";
    button.title = video.author?.name ? `查看 ${video.author.name}` : "查看作者";
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = shortVideoAuthorHandle(video.author?.name);
    const meta = document.createElement("em");
    meta.textContent = formatDate(video.publishedAt);
    copy.append(name, meta);
    button.append(copy);
    button.addEventListener("click", () => openShortVideoAuthorPage(video.author, video));
    return button;
  }

  function authorAvatar(author = {}, className = "short-video-author-avatar") {
    const avatar = document.createElement("span");
    avatar.className = className;
    if (author?.avatarUrl) {
      const img = document.createElement("img");
      img.src = author.avatarUrl;
      img.alt = author?.name || "作者";
      img.decoding = "async";
      img.addEventListener("error", () => {
        img.remove();
        avatar.classList.add("is-fallback");
        avatar.textContent = initials(author?.name || "?");
      }, { once: true });
      avatar.append(img);
    } else {
      avatar.classList.add("is-fallback");
      avatar.textContent = initials(author?.name || "?");
    }
    return avatar;
  }

  function ensureShortVideoCommentsView() {
    if (shortVideoCommentsViewPromise) return shortVideoCommentsViewPromise;
    const moduleUrl = "/modules/short-videos/comments-view.js?v=20260715-comments-lazy-01";
    shortVideoCommentsViewPromise = import(moduleUrl).then((module) => {
      if (typeof module.createShortVideoCommentsView !== "function") {
        throw new Error("评论模块加载失败");
      }
      return module.createShortVideoCommentsView({
        api,
        copyShortVideoValue,
        createIcon,
        formatCompact,
        formatLocalCommentDate,
        formatNumber,
        localShortVideoUrl,
        openDouyinLink,
        originalDouyinUrl,
        showBrowserToast
      });
    }).catch((error) => {
      shortVideoCommentsViewPromise = null;
      throw error;
    });
    return shortVideoCommentsViewPromise;
  }

  function lazyShortVideoCommentsView(video, panel) {
    const placeholder = document.createElement("div");
    placeholder.className = "short-video-comments short-video-related-status is-loading";
    placeholder.setAttribute("aria-busy", "true");
    placeholder.textContent = "正在载入评论…";
    const load = () => {
      placeholder.classList.add("is-loading");
      placeholder.setAttribute("aria-busy", "true");
      placeholder.textContent = "正在载入评论…";
      ensureShortVideoCommentsView().then((renderComments) => {
        if (!placeholder.isConnected || panel.dataset.activeTab !== "comments") return;
        placeholder.replaceWith(renderComments(video));
      }).catch((error) => {
        if (!placeholder.isConnected || panel.dataset.activeTab !== "comments") return;
        placeholder.classList.remove("is-loading");
        placeholder.removeAttribute("aria-busy");
        const message = document.createElement("span");
        message.textContent = error?.message || "评论模块加载失败";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "重试";
        retry.addEventListener("click", load);
        placeholder.replaceChildren(message, retry);
      });
    };
    load();
    return placeholder;
  }

  function ensureShortVideoAuthorPanel() {
    if (shortVideoAuthorPanelPromise) return shortVideoAuthorPanelPromise;
    markShortVideoPerformance("author-panel-module-start");
    const moduleUrl = "/modules/short-videos/author-panel.js?v=20260824-local-file-actions-01";
    shortVideoAuthorPanelPromise = import(moduleUrl).then((module) => {
      if (typeof module.createShortVideoAuthorPanel !== "function") {
        throw new Error("作者信息模块加载失败");
      }
      const showPanel = module.createShortVideoAuthorPanel({
        activateShortVideoCovers,
        activePlayer,
        activeReelStack,
        api,
        appendCaptionText,
        applyShortVideoLikeBadgeState,
        authorAvatar,
        bindAuthorPanelDragToClose,
        cacheAuthorPanelVideo,
        cacheAuthorPanelVideos,
        captionTitleWithTags,
        cardTitle,
        clearShortVideoDeleteSelection,
        closeAuthorPanel,
        closeTransientPlayerControls,
        commitShortVideoSearch,
        coverEagerCount,
        createAuthorFollowButton,
        createIcon,
        currentAuthorPanelVideoRequestId: () => authorPanelVideoRequestId,
        disposeShortVideoMedia,
        els,
        fetchShortVideoDetail,
        formatBytes,
        formatCompact,
        formatDate,
        formatDuration,
        formatNumber,
        formatShortVideoMetric,
        galleryBadge,
        galleryLabel,
        isGalleryPost,
        isolateAuthorPanelAsMobileModal,
        isShortVideoAuthorDetailPage,
        lazyShortVideoCommentsView,
        loadAdjacentVideos,
        nextAuthorPanelVideoRequestId: () => ++authorPanelVideoRequestId,
        normalizeShortVideoSortValue,
        normalizeShortVideoSound,
        normalizeShortVideoTopic,
        openAuthorDouyinLink, runShortVideoLocalAction,
        openDouyinLink,
        openShortVideoAuthorPage,
        prefetchRelatedVideo,
        refreshAdjacentPanelsDom,
        renderAuthorSignature,
        renderReelPanel,
        renderStats,
        replaceRoute,
        resolvedShortVideoDetail,
        resumeActiveSound,
        setAuthorPanelReturnFeed: (value) => {
          authorPanelReturnFeed = value;
        },
        setAuthorPanelTileMap: (value) => {
          authorPanelTileMap = value;
        },
        setReelPanelInteractionState,
        shortVideoAuthorHandle,
        shortVideoCardCoverUrl,
        shortVideoFeedSnapshot,
        shortVideoFriendlyError,
        shortVideosWithCovers,
        showBrowserToast,
        showError,
        state,
        syncAuthorPanelCurrentTile,
        syncCurrentNavigationDom,
        syncRelatedPanelCurrentItem,
        syncShortVideoBrowserSearchDom
      });
      markShortVideoPerformance("author-panel-module-ready");
      return showPanel;
    }).catch((error) => {
      shortVideoAuthorPanelPromise = null;
      markShortVideoPerformance("author-panel-module-error", {
        message: String(error?.message || error || "unknown")
      });
      throw error;
    });
    return shortVideoAuthorPanelPromise;
  }

  function showAuthorPanel(video, options = {}) {
    return ensureShortVideoAuthorPanel()
      .then((showPanel) => showPanel(video, options))
      .catch((error) => {
        showBrowserToast(error?.message || "作者信息模块加载失败");
      });
  }

  function authorScopeId(video = {}, author = {}) {
    return String(author?.secUid || video?.author?.secUid || "").trim();
  }

  function isCurrentShortVideo(video = {}, currentVideo = state.shortVideo?.current) {
    const id = String(video?.id || "").trim();
    const currentId = String(currentVideo?.id || "").trim();
    if (id && currentId && id === currentId) return true;
    const awemeId = String(video?.awemeId || "").trim();
    const currentAwemeId = String(currentVideo?.awemeId || "").trim();
    return Boolean(awemeId && currentAwemeId && awemeId === currentAwemeId);
  }

  function authorProfileLineText(author) {
    const parts = [];
    const douyinId = String(author?.shortId || author?.uniqueId || "").trim();
    if (douyinId) parts.push(`抖音号 ${douyinId}`);
    const ipLocation = String(author?.ipLocation || "").trim().replace(/^IP属地[:：]?\s*/u, "");
    if (ipLocation) parts.push(`IP ${ipLocation}`);
    const age = profileNumber(author?.age);
    if (age) parts.push(`${age}岁`);
    const verification = String(author?.verification || "").trim();
    if (verification) parts.push(verification);
    return parts.join(" · ");
  }

  function authorHasProfileMeta(author) {
    return Boolean(authorProfileLineText(author) || String(author?.signature || "").trim() || profileStatItems(author).length);
  }

  function profileNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  }

  function profileStatItems(author) {
    return [
      ["关注", profileNumber(author?.followingCount)],
      ["粉丝", profileNumber(author?.followerCount)],
      ["获赞", profileNumber(author?.totalFavorited)],
      ["作品", profileNumber(author?.awemeCount)]
    ].filter((item) => item[1] !== null);
  }
  function authorDouyinUrl(author) {
    const url = String(author?.profileUrl || "").trim();
    if (url) return url;
    const secUid = String(author?.secUid || "").trim();
    return secUid ? `https://www.douyin.com/user/${encodeURIComponent(secUid)}` : "";
  }

  function openAuthorDouyinLink(author) {
    const url = authorDouyinUrl(author);
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    showBrowserToast("没有作者主页");
  }

  function authorRailButton(video) {
    const wrap = document.createElement("div");
    wrap.className = "short-video-author-rail";
    const avatar = authorAvatar(video.author, "short-video-author-avatar");
    const profile = railButton("", avatar, "author", video.author?.name ? `作者 ${video.author.name}` : "作者", () => showAuthorPanel(video));
    const follow = createAuthorFollowButton(video, video.author, "rail");
    wrap.append(profile, follow);
    return wrap;
  }

  function setBodyClass() {
    document.body.classList.toggle("short-video-view", state.activeView === "shortVideos");
    document.body.classList.toggle("short-video-browser-active", state.activeView === "shortVideos" && Boolean(state.shortVideo?.current || shortVideoOpeningId));
    document.body.classList.toggle(
      "short-video-author-page-active",
      state.activeView === "shortVideos" && isShortVideoAuthorDetailPage() && !state.shortVideo?.current
    );
  }

  function showError(error) {
    state.shortVideo.loading = false;
    state.shortVideo.loadingMore = false;
    state.shortVideo.authorLoadingMore = false;
    state.shortVideo.status = shortVideoFriendlyError(error, "短视频读取失败");
    const preservedHome = els.workGrid?.querySelector?.('.short-video-home[aria-busy="true"]');
    if (preservedHome) {
      preservedHome.removeAttribute("aria-busy");
      showBrowserToast(state.shortVideo.status);
      return;
    }
    renderView();
  }

  function handleSummaryLoadError(error) {
    state.shortVideo.summaryLoading = false;
    console.warn(error);
  }

  function shortVideoFriendlyError(error, fallback) {
    const message = String(error?.message || "").trim();
    if (!message) return fallback;
    if (/database disk image|malformed|sqlite/i.test(message)) return "短视频数据正在恢复，请稍后重试";
    if (/failed to fetch|network|timeout/i.test(message)) return fallback;
    return message;
  }

  return {
    applyRouteState,
    enter,
    loadVideos,
    openRouteTarget,
    openVideo,
    renderStats,
    renderView
  };
}
