import { createApiClient, addQueryParam } from "./api.js?v=20260701-gallery-merge-01";

const api = createApiClient();
const params = new URLSearchParams(window.location.search);
const workId = params.get("workId") || "";
const mediaId = params.get("mediaId") || "";
const requestedVideoId = params.get("videoId") || "";
const returnTo = params.get("returnTo") || "";

const els = {
  title: document.querySelector("#playerTitle"),
  notice: document.querySelector("#playerNotice"),
  stage: document.querySelector(".player-stage"),
  video: document.querySelector("#playerVideo"),
  seekControl: document.querySelector("#playerSeekControl"),
  seekRange: document.querySelector("#playerSeekRange"),
  currentTime: document.querySelector("#playerCurrentTime"),
  durationTime: document.querySelector("#playerDurationTime"),
  tools: document.querySelector("#playerTools"),
  modeText: document.querySelector("#playerModeText"),
  statusText: document.querySelector("#playerStatusText"),
  sidebar: document.querySelector("#playerSidebar"),
  toggleSidebar: document.querySelector("#toggleSidebarButton"),
  toggleSidebarLabel: document.querySelector("#toggleSidebarButton .player-sidebar-toggle-label"),
  streamStart: document.querySelector("#playerStreamStart"),
  skipBack: document.querySelector("#skipBackButton"),
  skipForward: document.querySelector("#skipForwardButton"),
  reloadStream: document.querySelector("#reloadStreamButton"),
  files: document.querySelector("#playerFiles"),
  meta: document.querySelector("#playerMeta"),
  back: document.querySelector("#backButton"),
  markerA: document.querySelector("#markerAButton"),
  correctActor: document.querySelector("#correctActorButton"),
  moveToPerson: document.querySelector("#moveToPersonButton"),
  openFile: document.querySelector("#openFileButton"),
  deleteLocal: document.querySelector("#deleteLocalButton"),
  javdb: document.querySelector("#javdbLink")
};

let currentWork = null;
let currentVideo = null;
let currentPlayInfo = null;
let progressTimer = null;
let lastProgressReport = 0;
let playbackOffset = 0;
let isSeeking = false;
let player = null;
let playerControlMode = "";
let frameHoldCanvas = null;
let frameHoldTimer = null;
let uiIdleTimer = null;
let pointerMoveFrame = null;
let sidebarCollapsed = false;
let streamNeedsActivation = false;

const PLYR_DIRECT_CONTROLS = ["play-large", "play", "progress", "current-time", "duration", "mute", "volume", "settings", "fullscreen"];
const PLYR_STREAM_CONTROLS = ["play-large", "play", "mute", "volume", "fullscreen"];
const mobileStreamControlsQuery = window.matchMedia("(max-width: 640px)");
const mobileSidebarQuery = window.matchMedia("(max-width: 900px)");
const PLAYER_SIDEBAR_STORAGE_KEY = "fanhao.player.sidebar-collapsed";
const LOCAL_MARKER_RELEASE_DELAY_MS = 900;

initializePlayerExperience();

els.back?.addEventListener("click", () => {
  if (window.opener && !window.opener.closed) {
    window.close();
    return;
  }
  window.location.href = returnTo || (mediaId ? "/media" : "/");
});

els.openFile?.addEventListener("click", () => {
  openCurrentLocalFolder();
});

els.markerA?.addEventListener("click", () => {
  toggleLocalMarker("A");
});

els.deleteLocal?.addEventListener("click", () => {
  deleteCurrentLocalFiles();
});

els.correctActor?.addEventListener("click", () => {
  correctCurrentActorFromFolder();
});

els.moveToPerson?.addEventListener("click", () => {
  moveCurrentWorkToPerson();
});

els.toggleSidebar?.addEventListener("click", () => {
  setSidebarCollapsed(!sidebarCollapsed, { persist: true });
});

els.streamStart?.addEventListener("click", startDeferredStream);

els.video?.addEventListener("loadedmetadata", () => {
  updateVideoAspect();
  updateSeekControl();
});

els.video?.addEventListener("durationchange", () => {
  updateSeekControl();
});

els.video?.addEventListener("timeupdate", () => {
  updateSeekControl();
});

els.seekRange?.addEventListener("input", () => {
  isSeeking = true;
  updateSeekDisplay(Number(els.seekRange.value || 0));
});

els.seekRange?.addEventListener("change", () => {
  seekTo(Number(els.seekRange.value || 0));
});

els.skipBack?.addEventListener("click", () => {
  skipBy(-10);
});

els.skipForward?.addEventListener("click", () => {
  skipBy(30);
});

els.reloadStream?.addEventListener("click", () => {
  reloadCurrentStream();
});

els.video?.addEventListener("click", () => {
  return;
});

els.video?.addEventListener("waiting", () => {
  setPlaybackStatus("缓冲中", { transient: true });
});

els.video?.addEventListener("playing", () => {
  streamNeedsActivation = false;
  setPlaybackStatus(els.video.dataset.autoplayMuted === "1" ? "已静音自动播放，点击页面恢复声音" : "");
  hideFrameHold();
  scheduleUiIdle();
});

els.video?.addEventListener("pause", revealPlayerUi);
els.video?.addEventListener("ended", revealPlayerUi);

els.video?.addEventListener("error", () => {
  setPlaybackStatus(videoErrorMessage());
});

window.addEventListener("beforeunload", () => {
  reportProgress();
});

mobileStreamControlsQuery.addEventListener?.("change", () => {
  placeStreamSeekControl();
});

window.addEventListener("resize", updateVideoAspect);
document.addEventListener("keydown", handlePlayerKeyboard);
document.addEventListener("keydown", restoreAutoplayAudioFromInteraction, { capture: true });
document.addEventListener("click", restoreAutoplayAudioFromInteraction, { capture: true });
document.addEventListener("pointerdown", revealPlayerUi, { passive: true });
document.addEventListener("pointermove", handlePlayerPointerMove, { passive: true });

load();

function initializePlayerExperience() {
  let storedPreference = null;
  try {
    storedPreference = window.localStorage.getItem(PLAYER_SIDEBAR_STORAGE_KEY);
  } catch {}
  const collapsedByDefault = mobileSidebarQuery.matches;
  setSidebarCollapsed(storedPreference == null ? collapsedByDefault : storedPreference === "1");
  revealPlayerUi();
}

function setSidebarCollapsed(collapsed, options = {}) {
  sidebarCollapsed = Boolean(collapsed);
  document.body.classList.toggle("player-sidebar-collapsed", sidebarCollapsed);
  if (els.toggleSidebar) {
    els.toggleSidebar.setAttribute("aria-expanded", sidebarCollapsed ? "false" : "true");
    els.toggleSidebar.title = sidebarCollapsed ? "显示资料与操作（I）" : "隐藏资料与操作（I）";
  }
  if (els.toggleSidebarLabel) {
    els.toggleSidebarLabel.textContent = sidebarCollapsed ? "显示资料" : "隐藏资料";
  }
  if (els.sidebar) {
    if (sidebarCollapsed && els.sidebar.contains(document.activeElement)) {
      els.toggleSidebar?.focus({ preventScroll: true });
    }
    els.sidebar.inert = sidebarCollapsed;
    els.sidebar.setAttribute("aria-hidden", sidebarCollapsed ? "true" : "false");
  }
  if (options.persist) {
    try {
      window.localStorage.setItem(PLAYER_SIDEBAR_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
    } catch {}
  }
  window.requestAnimationFrame(updateVideoAspect);
  window.setTimeout(updateVideoAspect, 220);
}

function handlePlayerPointerMove() {
  if (pointerMoveFrame) return;
  pointerMoveFrame = window.requestAnimationFrame(() => {
    pointerMoveFrame = null;
    revealPlayerUi();
  });
}

function revealPlayerUi() {
  document.body.classList.remove("player-ui-idle");
  scheduleUiIdle();
}

function scheduleUiIdle() {
  window.clearTimeout(uiIdleTimer);
  if (!els.video || els.video.paused || els.video.ended) return;
  uiIdleTimer = window.setTimeout(() => {
    if (!els.video.paused && !els.video.ended) document.body.classList.add("player-ui-idle");
  }, 2200);
}

function handlePlayerKeyboard(event) {
  if (shouldIgnorePlayerShortcut(event)) return;
  const key = String(event.key || "").toLowerCase();
  if (key === "i") {
    event.preventDefault();
    setSidebarCollapsed(!sidebarCollapsed, { persist: true });
    revealPlayerUi();
    return;
  }
  if (!currentVideo || !currentPlayInfo || !els.video) return;
  if (key === " " || key === "k") {
    event.preventDefault();
    if (els.video.paused && streamNeedsActivation && usesCustomControls()) {
      startDeferredStream();
    } else if (els.video.paused) requestVideoPlayback();
    else els.video.pause();
  } else if (key === "arrowleft") {
    event.preventDefault();
    seekTo(mediaPosition() - 10);
  } else if (key === "arrowright") {
    event.preventDefault();
    seekTo(mediaPosition() + 10);
  } else if (key === "arrowup") {
    event.preventDefault();
    els.video.volume = Math.min(1, Number(els.video.volume || 0) + 0.05);
  } else if (key === "arrowdown") {
    event.preventDefault();
    els.video.volume = Math.max(0, Number(els.video.volume || 0) - 0.05);
  } else if (key === "m") {
    event.preventDefault();
    els.video.muted = !els.video.muted;
  } else if (key === "f") {
    event.preventDefault();
    player?.fullscreen?.toggle?.();
  } else if (key === "escape" && mobileSidebarQuery.matches && !sidebarCollapsed) {
    setSidebarCollapsed(true, { persist: true });
  } else {
    return;
  }
  revealPlayerUi();
}

function shouldIgnorePlayerShortcut(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return true;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, [contenteditable='true'], .player-move-dialog")) return true;
  return target.matches("button, a") && [" ", "enter"].includes(String(event.key || "").toLowerCase());
}

async function load() {
  if (!workId && !mediaId) {
    showNotice("缺少 workId 或 mediaId");
    return;
  }
  try {
    if (mediaId) {
      await loadGalleryMedia();
      return;
    }
    const data = await api(`/api/works/${encodeURIComponent(workId)}`);
    currentWork = data.work;
    document.title = `${currentWork.title} - FanHao`;
    els.title.textContent = currentWork.title;
    renderFiles(currentWork);
    renderMeta(currentWork);
    updateMarkerButton();
    updateDeleteLocalButton();
    updateCorrectActorButton();
    updateMoveToPersonButton();
    const video = selectInitialVideo(currentWork);
    if (!video) {
      showNotice("这个作品没有可播放的视频");
      return;
    }
    await playVideo(video);
  } catch (error) {
    showNotice(error.message || "读取作品失败");
  }
}

function startDeferredStream() {
  if (!streamNeedsActivation || !usesCustomControls() || !els.video) return;
  streamNeedsActivation = false;
  setStreamPending(false);
  beginStreamSwitch(false);
  setPlaybackStatus("加载中");
  requestVideoPlayback();
}

function setStreamPending(pending) {
  const active = Boolean(pending);
  els.stage?.classList.toggle("stream-pending", active);
  if (els.streamStart) els.streamStart.hidden = !active;
}

async function loadGalleryMedia() {
  const data = await api(`/api/gallery-media/${encodeURIComponent(mediaId)}`);
  currentWork = galleryMediaAsWork(data.item);
  document.title = `${currentWork.title} - FanHao`;
  els.title.textContent = currentWork.title;
  renderFiles(currentWork);
  renderMeta(currentWork);
  updateMarkerButton();
  updateDeleteLocalButton();
  updateCorrectActorButton();
  updateMoveToPersonButton();
  const video = selectInitialVideo(currentWork);
  if (!video) {
    showNotice("这个影视文件不可播放");
    return;
  }
  await playVideo(video);
}

function galleryMediaAsWork(media = {}) {
  const metadata = media.mediaKind === "movie" ? media.movieMetadata || {} : media.tvSeries || {};
  const title = media.mediaKind === "movie"
    ? [metadata.title || metadata.movieTitle || media.title, metadata.year ? `(${metadata.year})` : ""].filter(Boolean).join(" ")
    : metadata.title || media.seriesName || media.title || "影视";
  const videos = Array.isArray(media.videos) && media.videos.length ? media.videos : [{
    id: media.id,
    name: media.title || "视频",
    title: media.title || "",
    relativePath: media.relativePath || "",
    ext: media.ext || "",
    size: media.size || 0,
    playable: Boolean(media.playable),
    progress: media.progress || null
  }];
  return {
    id: media.id,
    type: "gallery-media",
    galleryMedia: true,
    mediaKind: media.mediaKind || "",
    title,
    directoryName: media.title || title,
    relativePath: media.relativePath || "",
    personName: media.mediaKind === "tv" ? media.seriesName || "" : media.personName || "",
    personDisplayName: media.mediaKind === "tv" ? media.seriesName || "" : media.personName || "",
    sourcePaths: [media.relativePath || ""].filter(Boolean),
    videoCount: videos.length,
    playableCount: videos.filter((video) => video.playable).length,
    videoSize: media.size || videos.reduce((sum, video) => sum + Number(video.size || 0), 0),
    videos,
    progress: media.progress || videos.find((video) => video.progress)?.progress || null,
    infoSummary: {
      title,
      releaseDate: metadata.pubdate || (metadata.releaseDates || [])[0] || "",
      rating: metadata.rating || null,
      ratingCount: metadata.ratingCount || null,
      actors: metadata.actors || [],
      maker: media.kindLabel || "",
      series: media.mediaKind === "tv" ? media.seriesName || "" : "",
      tags: metadata.genres || []
    },
    galleryMetadata: metadata,
    category: media.category || "",
    subCategory: media.subCategory || "",
    kindLabel: media.kindLabel || "",
    size: media.size || 0
  };
}

function selectInitialVideo(work) {
  const videos = work.videos || [];
  return (
    videos.find((video) => video.id === requestedVideoId) ||
    videos.find((video) => video.id === work.progress?.videoId) ||
    videos.find((video) => video.playable) ||
    videos[0] ||
    null
  );
}

function renderFiles(work) {
  els.files.innerHTML = "";
  for (const video of work.videos || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `player-file-button${video.id === currentVideo?.id ? " active" : ""}`;
    button.innerHTML = `<strong></strong><span></span>`;
    button.querySelector("strong").textContent = video.name || video.title || "视频";
    button.querySelector("span").textContent = `${formatLibraryPath(video.relativePath)}${video.progress?.percent ? ` · ${Math.floor(video.progress.percent)}%` : ""}`;
    button.addEventListener("click", () => playVideo(video));
    els.files.append(button);
  }
}

async function playVideo(video, options = {}) {
  reportProgress();
  stopProgressTimer();
  currentVideo = video;
  renderFiles(currentWork);
  updateOpenFileButton();
  updateDeleteLocalButton();
  showNotice("正在准备播放");
  els.video.hidden = true;
  els.video.pause();
  els.video.removeAttribute("src");
  els.video.load();
  currentPlayInfo = null;
  playbackOffset = 0;
  isSeeking = false;
  setPlyrLayoutMode(false);
  hidePlaybackControls();

  try {
    const sourceQuery = mediaId ? "?source=gallery" : "";
    const playInfo = await api(`/api/playinfo/${encodeURIComponent(video.id)}${sourceQuery}`);
    currentPlayInfo = playInfo;
    const savedProgress = video.progress || (currentWork.progress?.videoId === video.id ? currentWork.progress : null);
    const requestedResumePosition = Number(options.resumePosition);
    const resumePosition = Number.isFinite(requestedResumePosition)
      ? Math.max(0, requestedResumePosition)
      : (savedProgress?.position > 5 ? Number(savedProgress.position) : 0);
    setPlaybackStatus("准备中");
    setVideoSourceAt(resumePosition, { autoPlay: options.autoPlay !== false });
    startProgressTimer();
  } catch (error) {
    showNotice(error.message || "播放失败");
  }
}

function setVideoSourceAt(position, options = {}) {
  if (!currentPlayInfo?.streamUrl || !els.video) return;
  const target = clampSeekTime(position);
  const mode = currentPlayInfo.mode || "direct";
  const autoPlay = Boolean(options.autoPlay);
  const customControls = mode !== "direct";
  const deferGeneratedStream = customControls && !autoPlay;
  let streamUrl = currentPlayInfo.streamUrl;
  els.video.preload = mode === "direct" ? "auto" : "none";
  els.video.setAttribute("preload", els.video.preload);
  updateVideoAspect();
  configurePlyrForCurrentMode();
  els.video.preload = mode === "direct" ? "auto" : "none";
  playbackOffset = mode === "direct" ? 0 : target;
  streamNeedsActivation = deferGeneratedStream;
  setStreamPending(deferGeneratedStream);
  if (customControls && !deferGeneratedStream) {
    beginStreamSwitch(options.holdFrame);
    setPlaybackStatus(target > 0 ? "跳转中" : "加载中");
  } else if (deferGeneratedStream) {
    setPlaybackStatus("");
  }

  if (mode !== "direct" && target > 0) {
    streamUrl = addQueryParam(streamUrl, "t", Math.floor(target));
  }

  els.video.pause();
  els.video.src = streamUrl;
  els.video.hidden = false;
  els.notice.hidden = true;

  if (deferGeneratedStream) {
    updateSeekControl(target);
    return;
  }

  els.video.addEventListener(
    "loadedmetadata",
    () => {
      if (mode === "direct" && target > 0 && Number.isFinite(els.video.duration) && target < els.video.duration) {
        els.video.currentTime = target;
      }
      updateSeekControl(target);
      if (autoPlay) {
        requestVideoPlayback({ allowMutedFallback: true });
      }
    },
    { once: true }
  );

  if (customControls) {
    els.video.addEventListener(
      "canplay",
      () => {
        setPlaybackStatus("");
        if (autoPlay) {
          requestVideoPlayback({ allowMutedFallback: true });
        }
        endStreamSwitchSoon();
      },
      { once: true }
    );
  }

  els.video.load();
  if (customControls && autoPlay) {
    requestVideoPlayback({ allowMutedFallback: true });
  }
  updateSeekControl(target);
}

function requestVideoPlayback(options = {}) {
  const attempt = els.video?.play?.();
  if (!attempt?.then) return;
  attempt.then(() => {
    if (els.video) delete els.video.dataset.playbackError;
    streamNeedsActivation = false;
    setStreamPending(false);
  }).catch((error) => {
    const name = String(error?.name || "PlaybackError");
    const message = String(error?.message || "播放启动失败").trim();
    if (name === "NotAllowedError" && options.allowMutedFallback && els.video && !els.video.muted) {
      els.video.muted = true;
      els.video.dataset.autoplayMuted = "1";
      setPlaybackStatus("已静音自动播放，点击页面恢复声音");
      requestVideoPlayback();
      return;
    }
    if (els.video) els.video.dataset.playbackError = `${name}: ${message}`;
    if (usesCustomControls()) {
      streamNeedsActivation = true;
      setStreamPending(true);
      setPlaybackStatus(name === "NotAllowedError" ? "点击播放" : "播放启动失败，点击重试");
    }
    console.warn("[player-play]", name, message);
  });
}

function restoreAutoplayAudioFromInteraction() {
  if (!els.video || els.video.dataset.autoplayMuted !== "1") return;
  delete els.video.dataset.autoplayMuted;
  els.video.muted = false;
  requestVideoPlayback();
  setPlaybackStatus("");
}

function usesCustomControls() {
  return currentPlayInfo && (currentPlayInfo.mode || "direct") !== "direct";
}

function setPlyrLayoutMode(directMode) {
  if (els.video) els.video.controls = false;
  els.stage?.classList.toggle("native-controls", Boolean(directMode));
  els.stage?.classList.toggle("stream-controls", Boolean(currentPlayInfo && !directMode));
}

function configurePlyrForCurrentMode() {
  if (!els.video || !window.Plyr || !currentPlayInfo) return;
  const directMode = (currentPlayInfo.mode || "direct") === "direct";
  const nextMode = directMode ? "direct" : "stream";
  setPlyrLayoutMode(directMode);
  if (player && playerControlMode === nextMode) {
    placeStreamSeekControl();
    return;
  }

  if (player) {
    restoreStreamSeekControl();
    hideFrameHold();
    try {
      player.destroy();
    } catch {}
    player = null;
    frameHoldCanvas = null;
  }

  playerControlMode = nextMode;
  player = new window.Plyr(els.video, {
    controls: directMode ? PLYR_DIRECT_CONTROLS : PLYR_STREAM_CONTROLS,
    iconUrl: "/vendor/plyr/plyr.svg",
    invertTime: false,
    keyboard: { focused: true, global: false },
    tooltips: { controls: true, seek: directMode }
  });
  placeStreamSeekControl();
}

function placeStreamSeekControl() {
  const controls = player?.elements?.controls;
  if (!usesCustomControls() || !controls || !els.seekControl) return;
  if (mobileStreamControlsQuery.matches) {
    if (els.seekControl.parentElement !== els.stage) {
      els.stage?.append(els.seekControl);
    }
    return;
  }
  if (els.seekControl.parentElement !== controls) {
    const playButton = controls.querySelector('[data-plyr="play"]');
    if (playButton?.nextSibling) {
      controls.insertBefore(els.seekControl, playButton.nextSibling);
    } else {
      controls.append(els.seekControl);
    }
  }
}

function restoreStreamSeekControl() {
  if (!els.seekControl || !els.stage || els.seekControl.parentElement === els.stage) return;
  els.stage.append(els.seekControl);
}

function ensureFrameHoldCanvas() {
  if (frameHoldCanvas?.isConnected) return frameHoldCanvas;
  const videoWrapper = player?.elements?.container?.querySelector(".plyr__video-wrapper");
  if (!videoWrapper) return null;
  frameHoldCanvas = document.createElement("div");
  frameHoldCanvas.className = "player-frame-hold";
  frameHoldCanvas.hidden = true;
  videoWrapper.append(frameHoldCanvas);
  return frameHoldCanvas;
}

function beginStreamSwitch(holdFrame) {
  els.stage?.classList.add("stream-switching");
  if (holdFrame) showFrameHold();
}

function endStreamSwitchSoon() {
  window.setTimeout(hideFrameHold, 160);
}

function showFrameHold() {
  const hold = ensureFrameHoldCanvas();
  if (!hold || !els.video || !els.video.videoWidth || !els.video.videoHeight) return;
  try {
    updateVideoAspect();
    const canvas = document.createElement("canvas");
    canvas.width = els.video.videoWidth;
    canvas.height = els.video.videoHeight;
    canvas.getContext("2d").drawImage(els.video, 0, 0, canvas.width, canvas.height);
    hold.style.backgroundImage = `url("${canvas.toDataURL("image/jpeg", 0.86)}")`;
    hold.classList.remove("fading");
    hold.hidden = false;
    window.clearTimeout(frameHoldTimer);
    frameHoldTimer = window.setTimeout(hideFrameHold, 6000);
  } catch {
    hold.hidden = true;
  }
}

function updateVideoAspect() {
  if (!els.stage) return;
  const sourceWidth = Number(els.video?.videoWidth || currentPlayInfo?.width || 16);
  const sourceHeight = Number(els.video?.videoHeight || currentPlayInfo?.height || 9);
  const safeWidth = Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : 16;
  const safeHeight = Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : 9;
  const ratio = safeWidth / safeHeight;
  const availableWidth = Math.max(0, els.stage.clientWidth || 0);
  const availableHeight = Math.max(0, els.stage.clientHeight || 0);
  const fittedWidth = availableWidth && availableHeight
    ? Math.min(availableWidth, availableHeight * ratio)
    : availableWidth;
  els.stage.style.setProperty("--player-video-aspect", `${safeWidth} / ${safeHeight}`);
  if (fittedWidth > 0) {
    els.stage.style.setProperty("--player-video-max-width", `${Math.floor(fittedWidth)}px`);
  }
}

function hideFrameHold() {
  if (!frameHoldCanvas || frameHoldCanvas.hidden) {
    els.stage?.classList.remove("stream-switching");
    return;
  }
  window.clearTimeout(frameHoldTimer);
  frameHoldCanvas.classList.add("fading");
  frameHoldTimer = window.setTimeout(() => {
    if (!frameHoldCanvas) return;
    frameHoldCanvas.hidden = true;
    frameHoldCanvas.style.backgroundImage = "";
    frameHoldCanvas.classList.remove("fading");
    els.stage?.classList.remove("stream-switching");
  }, 200);
}

function skipBy(seconds) {
  if (!currentVideo || !currentPlayInfo || !usesCustomControls()) return;
  seekTo(mediaPosition() + seconds);
}

function reloadCurrentStream() {
  if (!currentVideo || !currentPlayInfo || !els.video || !usesCustomControls()) return;
  const wasPaused = els.video.paused;
  setVideoSourceAt(mediaPosition(), { autoPlay: !wasPaused, holdFrame: true });
}

function seekTo(position) {
  if (!currentVideo || !currentPlayInfo || !els.video) return;
  const target = clampSeekTime(position);
  const wasPaused = els.video.paused;
  isSeeking = false;

  if ((currentPlayInfo.mode || "direct") === "direct") {
    if (Number.isFinite(els.video.duration) && target <= els.video.duration) {
      els.video.currentTime = target;
    }
    updateSeekControl(target);
    reportProgress(target, { force: true });
    return;
  }

  reportProgress(target, { force: true });
  setVideoSourceAt(target, { autoPlay: !wasPaused, holdFrame: true });
}

function mediaDuration() {
  const probedDuration = Number(currentPlayInfo?.duration || 0);
  if (Number.isFinite(probedDuration) && probedDuration > 0) return probedDuration;
  const savedDuration = Number(currentVideo?.progress?.duration || currentWork?.progress?.duration || 0);
  if (Number.isFinite(savedDuration) && savedDuration > 0) return savedDuration;
  const metadataDuration = Number(currentWork?.infoSummary?.durationMinutes || 0) * 60;
  if (Number.isFinite(metadataDuration) && metadataDuration > 0) return metadataDuration;
  const elementDuration = Number(els.video?.duration || 0);
  return Number.isFinite(elementDuration) && elementDuration > 0 ? elementDuration : 0;
}

function mediaPosition() {
  const elementPosition = Number(els.video?.currentTime || 0);
  const position = (currentPlayInfo?.mode || "direct") === "direct" ? elementPosition : playbackOffset + elementPosition;
  return clampSeekTime(position);
}

function clampSeekTime(position) {
  const duration = mediaDuration();
  const value = Math.max(0, Number(position || 0) || 0);
  if (duration > 0) return Math.min(value, duration);
  return value;
}

function updateSeekControl(position = mediaPosition()) {
  const duration = mediaDuration();
  const available = Boolean(currentVideo && currentPlayInfo);
  if (!els.seekControl || !els.seekRange || !available || !usesCustomControls()) {
    hidePlaybackControls();
    updatePlaybackToolState();
    return;
  }

  els.seekControl.hidden = false;
  if (!duration) {
    els.seekRange.disabled = true;
    els.seekRange.value = "0";
    els.seekRange.max = "0";
    updateSeekDisplay(0);
    updatePlaybackToolState();
    return;
  }

  els.seekRange.disabled = false;
  els.seekRange.max = String(duration);
  if (!isSeeking) {
    els.seekRange.value = String(clampSeekTime(position));
  }
  updateSeekDisplay(isSeeking ? Number(els.seekRange.value || 0) : position);
  updatePlaybackToolState();
}

function updateSeekDisplay(position) {
  const duration = mediaDuration();
  const safePosition = duration > 0 ? Math.min(Math.max(0, Number(position || 0) || 0), duration) : 0;
  if (els.currentTime) els.currentTime.textContent = formatPlaybackTime(safePosition);
  if (els.durationTime) {
    els.durationTime.textContent = usesCustomControls()
      ? `${formatPlaybackTime(safePosition)} / ${formatPlaybackTime(duration)}`
      : formatPlaybackTime(duration);
  }
}

function hideSeekControlOnly() {
  if (els.seekControl) els.seekControl.hidden = true;
  if (els.seekRange) {
    els.seekRange.disabled = true;
    els.seekRange.value = "0";
    els.seekRange.max = "0";
  }
  updateSeekDisplay(0);
}

function hidePlaybackControls() {
  els.stage?.classList.remove("stream-switching");
  hideSeekControlOnly();
  if (els.tools) els.tools.hidden = true;
  if (els.modeText) els.modeText.textContent = "";
  if (els.statusText) els.statusText.textContent = "";
}

function updatePlaybackToolState() {
  const available = Boolean(currentVideo && currentPlayInfo && usesCustomControls());
  if (els.tools) els.tools.hidden = !available;
  if (els.skipBack) els.skipBack.disabled = !available;
  if (els.skipForward) els.skipForward.disabled = !available;
  if (els.reloadStream) els.reloadStream.disabled = !available;
  updateModeText();
}

function setPlaybackStatus(message) {
  if (els.statusText) {
    els.statusText.textContent = String(message || "").trim();
  }
  updatePlaybackToolState();
}

function updateModeText() {
  if (!els.modeText) return;
  els.modeText.textContent = playbackModeText();
}

function playbackModeText() {
  if (!currentPlayInfo) return "";
  const details = [
    videoExtensionLabel(currentVideo),
    currentPlayInfo.label || modeLabel(currentPlayInfo.mode),
    codecPairLabel(currentPlayInfo)
  ].filter(Boolean);
  return details.join(" · ");
}

function modeLabel(mode) {
  if (mode === "direct") return "原生直连";
  if (mode === "remux") return "快速重封装";
  if (mode === "transcode") return "智能转码";
  return "";
}

function codecPairLabel(playInfo) {
  const videoCodec = String(playInfo?.videoCodec || "").trim();
  const audioCodec = String(playInfo?.audioCodec || "").trim();
  return [videoCodec, audioCodec].filter(Boolean).join("/");
}

function videoExtensionLabel(video) {
  return String(video?.ext || video?.name?.split(".").pop() || "").replace(/^\./, "").toUpperCase();
}

function videoErrorMessage() {
  const message = "播放中断，可刷新流或换一个文件";
  if (!currentPlayInfo) return message;
  return `${message} · ${playbackModeText()}`;
}

function formatPlaybackTime(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds || 0) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const rest = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function renderMeta(work) {
  const info = work.infoSummary || {};
  els.meta.innerHTML = "";
  if (els.javdb) {
    els.javdb.hidden = true;
    els.javdb.removeAttribute("href");
  }
  if (work.galleryMedia) {
    renderGalleryMediaMeta(work);
    return;
  }
  appendMeta("番号", info.code || "");
  appendMeta("标题", info.title || work.title || "");
  appendMeta("日期", info.releaseDate || "");
  appendMeta("时长", info.durationMinutes ? `${info.durationMinutes} 分钟` : "");
  appendMeta("评分", info.rating ? `${info.rating} 分${info.ratingCount ? `，${info.ratingCount} 人评价` : ""}` : "");
  const actors = actorItems(work);
  if (actors.length) {
    appendEntityRow("演员", actors);
  } else {
    appendMeta("演员", work.personDisplayName || "");
  }
  const makers = makerItems(work);
  if (makers.length) appendEntityRow("片商", makers);
  const series = seriesItems(work);
  if (series.length) appendEntityRow("系列", series);
  const tags = tagItems(work);
  if (tags.length) appendEntityRow("标签", tags);
  const url = info.javdbUrl || work.javdbUrl || "";
  if (url) {
    els.javdb.href = url;
    els.javdb.hidden = false;
  }
}

function renderGalleryMediaMeta(work) {
  const metadata = work.galleryMetadata || {};
  appendMeta("类型", work.mediaKind === "tv" ? "电视剧" : "电影");
  appendMeta("标题", work.title || "");
  appendMeta(work.mediaKind === "tv" ? "首播" : "上映", metadata.pubdate || (metadata.releaseDates || []).join(" / "));
  appendMeta("评分", metadata.rating ? `${metadata.rating} 分${metadata.ratingCount ? `，${metadata.ratingCount} 人评价` : ""}` : "");
  appendMeta("分类", [work.category, work.subCategory].filter(Boolean).join(" / "));
  appendMeta("系列", work.mediaKind === "tv" ? work.personDisplayName || "" : "");
  const people = uniqueTextList([...(metadata.directors || []), ...(metadata.actors || [])]);
  if (people.length) appendEntityRow("演职员", people.slice(0, 16).map((name) => ({ name })));
  const genres = uniqueTextList(metadata.genres || []);
  if (genres.length) appendEntityRow("标签", genres.map((name) => ({ name })));
  appendMeta("地区语言", [(metadata.countries || []).join(" / "), (metadata.languages || []).join(" / ")].filter(Boolean).join(" · "));
  appendMeta("片长", (metadata.durations || []).join(" / ") || metadata.episodeDuration || "");
  appendMeta("IMDb", metadata.imdbId || "");
  appendMeta("文件", work.directoryName || "");
  appendMeta("路径", work.relativePath || "");
}

function appendMeta(label, value) {
  const text = String(value || "").trim();
  if (!text) return;
  const row = document.createElement("div");
  row.className = "player-meta-row";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("span");
  val.textContent = text;
  row.append(key, val);
  els.meta.append(row);
}

function appendEntityRow(label, items) {
  const row = document.createElement("div");
  row.className = "player-entity-row";
  const key = document.createElement("span");
  key.textContent = label;
  const chips = document.createElement("div");
  chips.className = "player-entity-chips";

  for (const item of items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "player-entity-chip";
    button.textContent = item.name;
    button.title = item.personId ? `返回人物：${item.name}` : item.url ? `打开：${item.url}` : `返回搜索：${item.name}`;
    button.addEventListener("click", () => {
      if (item.personId) {
        navigateLibrary(`/?personId=${encodeURIComponent(item.personId)}`);
      } else if (item.url) {
        window.open(item.url, "_blank", "noreferrer");
      } else {
        navigateLibrary(`/?q=${encodeURIComponent(item.name)}`);
      }
    });
    chips.append(button);
  }

  row.append(key, chips);
  els.meta.append(row);
}

function actorItems(work) {
  const info = work.infoSummary || {};
  const linkMap = entityLinkMap(info.actorLinks || work.infoMetadata?.actorLinks || []);
  const actors = uniqueTextList(info.actors || []);
  if (actors.length) {
    return actors.map((name) => ({ name, personId: matchingPersonId(name, work), url: linkMap.get(entityKey(name)) || "" }));
  }
  const fallback = work.personDisplayName || work.personName || "";
  return fallback ? [{ name: fallback, personId: work.personId || "" }] : [];
}

function tagItems(work) {
  const info = work.infoSummary || {};
  const linkMap = entityLinkMap(info.tagLinks || work.infoMetadata?.tagLinks || []);
  const tags = Array.isArray(info.tags) && info.tags.length ? info.tags : work.infoMetadata?.tags || [];
  return uniqueTextList(tags).map((name) => ({ name, url: linkMap.get(entityKey(name)) || "" }));
}

function makerItems(work) {
  const info = work.infoSummary || {};
  return uniqueEntityItems([
    { name: info.maker, url: cleanRemoteUrl(info.makerUrl || work.infoMetadata?.makerUrl) },
    { name: info.label, url: cleanRemoteUrl(info.labelUrl || work.infoMetadata?.labelUrl) }
  ]);
}

function seriesItems(work) {
  const info = work.infoSummary || {};
  return uniqueEntityItems([{ name: info.series, url: cleanRemoteUrl(info.seriesUrl || work.infoMetadata?.seriesUrl) }]);
}

function matchingPersonId(name, work) {
  return sameText(name, work.personDisplayName) || sameText(name, work.personName) ? work.personId || "" : "";
}

function uniqueTextList(values) {
  const seen = new Set();
  const list = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    list.push(text);
  }
  return list;
}

function sameText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function uniqueEntityItems(items) {
  const seen = new Set();
  const output = [];
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const key = entityKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ ...item, name });
  }
  return output;
}

function entityLinkMap(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item?.name || item?.label || item?.text || "").trim();
    const url = cleanRemoteUrl(item?.url || item?.href || "");
    if (name && url) map.set(entityKey(name), url);
  }
  return map;
}

function entityKey(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanRemoteUrl(value) {
  const url = String(value || "").trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

function navigateLibrary(url) {
  if (window.opener && !window.opener.closed) {
    window.opener.location.href = url;
    window.opener.focus?.();
    window.close();
    return;
  }
  window.location.href = url;
}

async function toggleLocalMarker(marker) {
  if (!els.markerA || !currentWork?.id) return;
  const key = String(marker || "").toUpperCase();
  const nextEnabled = !(currentWork.localMarkers || []).includes(key);
  const workBeforeMutation = currentWork;
  const playbackSnapshot = capturePlaybackSnapshot();
  const originalText = els.markerA.textContent;
  els.markerA.disabled = true;
  els.markerA.textContent = playbackSnapshot?.videoId ? "释放播放" : (nextEnabled ? "标记中" : "移除中");
  try {
    if (playbackSnapshot?.videoId) {
      reportProgress(playbackSnapshot.position, { force: true });
      stopCurrentPlayback();
      await delay(LOCAL_MARKER_RELEASE_DELAY_MS);
      els.markerA.textContent = nextEnabled ? "标记中" : "移除中";
    }
    const data = await api(`/api/works/${encodeURIComponent(workBeforeMutation.id)}/local-marker`, {
      method: "POST",
      body: { marker: key, enabled: nextEnabled }
    });
    if (data.work) {
      currentWork = data.work;
      document.title = `${currentWork.title} - FanHao`;
      els.title.textContent = currentWork.title;
      renderFiles(currentWork);
      renderMeta(currentWork);
    }
    updateMarkerButton();
    updateDeleteLocalButton();
    updateCorrectActorButton();
    await restorePlaybackSnapshot(playbackSnapshot);
  } catch (error) {
    currentWork = workBeforeMutation;
    await restorePlaybackSnapshot(playbackSnapshot);
    els.markerA.textContent = "标记失败";
    els.markerA.title = error.message || "标记失败";
    window.setTimeout(updateMarkerButton, 2000);
  } finally {
    els.markerA.disabled = false;
    if (els.markerA.textContent === originalText) updateMarkerButton();
  }
}

function capturePlaybackSnapshot() {
  if (!currentVideo?.id) return null;
  const hasPreparedPlayback = Boolean(currentPlayInfo);
  return {
    videoId: currentVideo.id,
    position: hasPreparedPlayback ? mediaPosition() : Number(currentVideo.progress?.position || 0),
    autoPlay: hasPreparedPlayback ? (!els.video.paused && !els.video.ended) : true,
    muted: Boolean(els.video.muted),
    volume: Number(els.video.volume)
  };
}

async function restorePlaybackSnapshot(snapshot) {
  if (!snapshot?.videoId || !currentWork) return;
  const video = (currentWork.videos || []).find((item) => item.id === snapshot.videoId) || selectInitialVideo(currentWork);
  if (!video) return;
  if (Number.isFinite(snapshot.volume)) els.video.volume = snapshot.volume;
  els.video.muted = snapshot.muted;
  await playVideo(video, {
    resumePosition: snapshot.position,
    autoPlay: snapshot.autoPlay
  });
}

function updateMarkerButton() {
  if (!els.markerA) return;
  const active = (currentWork?.localMarkers || []).includes("A");
  els.markerA.hidden = !currentWork || Boolean(currentWork.missingLocal) || Boolean(currentWork.galleryMedia);
  els.markerA.classList.toggle("active", active);
  els.markerA.textContent = active ? "A 已标记" : "标记 A";
  els.markerA.title = active ? "移除 A 标记" : "添加 A 标记";
}

async function openCurrentLocalFolder() {
  if (!els.openFile || !currentVideo?.id || !isLocalFileOpenAvailable()) return;
  const originalText = els.openFile.textContent;
  els.openFile.disabled = true;
  els.openFile.textContent = "打开中";
  try {
    await api("/api/open-folder", { method: "POST", body: { videoId: currentVideo.id } });
    els.openFile.textContent = "已打开";
    window.setTimeout(() => {
      els.openFile.textContent = originalText;
      els.openFile.disabled = false;
    }, 1200);
  } catch (error) {
    els.openFile.textContent = "打开失败";
    els.openFile.title = error.message || "打开失败";
    window.setTimeout(() => {
      els.openFile.textContent = originalText;
      els.openFile.disabled = false;
      updateOpenFileButton();
    }, 2000);
  }
}

function updateOpenFileButton() {
  if (!els.openFile) return;
  const available = isLocalFileOpenAvailable() && Boolean(currentVideo?.id);
  els.openFile.hidden = !available;
  els.openFile.disabled = !available;
  els.openFile.textContent = "打开文件夹";
  els.openFile.title = available ? formatLibraryPath(currentVideo.relativePath) : "";
}

function updateDeleteLocalButton() {
  if (!els.deleteLocal) return;
  const available = isTrustedNetworkFeatureAvailable() && currentWork && !currentWork.missingLocal && !currentWork.galleryMedia;
  els.deleteLocal.hidden = !available;
  els.deleteLocal.disabled = !available;
  els.deleteLocal.textContent = "删除本地文件";
  els.deleteLocal.title = available ? "删除这个作品的本地文件夹，并保留资料库记录" : "";
}

function updateCorrectActorButton() {
  if (!els.correctActor) return;
  const available = isTrustedNetworkFeatureAvailable() && currentWork && !currentWork.missingLocal && !currentWork.galleryMedia;
  els.correctActor.hidden = !available;
  els.correctActor.disabled = !available;
  els.correctActor.textContent = "订正演员";
  els.correctActor.title = available ? "按本地文件夹名订正这个作品的演员关联" : "";
}

function updateMoveToPersonButton() {
  if (!els.moveToPerson) return;
  const available = isTrustedNetworkFeatureAvailable() && currentWork && !currentWork.missingLocal && !currentWork.galleryMedia;
  els.moveToPerson.hidden = !available;
  els.moveToPerson.disabled = !available;
  els.moveToPerson.textContent = "迁移演员";
  els.moveToPerson.title = available ? "移动作品文件夹，并把作品分配给指定人物" : "";
}

function parsePersonIdInput(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d+$/.test(text)) return text;
  try {
    const url = new URL(text, window.location.origin);
    const queryId = url.searchParams.get("personId") || url.searchParams.get("person");
    if (queryId && /^\d+$/.test(queryId)) return queryId;
  } catch {}
  const match = /(?:personId|person)=([0-9]+)/i.exec(text);
  return match ? match[1] : "";
}

function normalizePersonSearchText(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
}

function movePersonSearchValues(person) {
  const profile = person?.actorProfile || {};
  return [
    person?.id,
    person?.name,
    profile.personName,
    profile.displayName,
    ...(Array.isArray(profile.aliases) ? profile.aliases : [])
  ].map(normalizePersonSearchText).filter(Boolean);
}

function movePersonMatchScore(person, query) {
  const normalizedQuery = normalizePersonSearchText(query);
  if (!normalizedQuery) return Number.POSITIVE_INFINITY;
  const values = movePersonSearchValues(person);
  const id = normalizePersonSearchText(person?.id);
  if (id === normalizedQuery) return 0;
  const exactIndex = values.findIndex((value) => value === normalizedQuery);
  if (exactIndex >= 0) return exactIndex <= 2 ? 1 : 2;
  if (values.some((value) => value.startsWith(normalizedQuery))) return 3;
  if (values.some((value) => value.includes(normalizedQuery))) return 4;
  return Number.POSITIVE_INFINITY;
}

function searchMovePeople(people, query, limit = 10) {
  return (Array.isArray(people) ? people : [])
    .map((person) => ({ person, score: movePersonMatchScore(person, query) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      const workDifference = Number(right.person.workCount || 0) - Number(left.person.workCount || 0);
      if (workDifference) return workDifference;
      return String(left.person.name || "").localeCompare(String(right.person.name || ""), "ja");
    })
    .slice(0, limit)
    .map((item) => item.person);
}

async function movePeopleForSearch() {
  const data = await api("/api/library");
  return Array.isArray(data.people) ? data.people : [];
}

function safeFolderName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 120);
}

async function libraryRootsForMove() {
  const data = await api("/api/library/roots");
  const roots = Array.isArray(data.availableRoots) && data.availableRoots.length ? data.availableRoots : data.roots || [];
  return {
    roots,
    defaultRoot: data.defaultRoot || roots[0] || ""
  };
}

function closeMoveDialog(overlay, result, resolve) {
  overlay.remove();
  resolve(result || null);
}

async function openMovePersonDialog() {
  const [{ roots, defaultRoot }, movePeople] = await Promise.all([
    libraryRootsForMove(),
    movePeopleForSearch()
  ]);
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "player-move-backdrop";
    overlay.setAttribute("role", "presentation");

    const dialog = document.createElement("section");
    dialog.className = "player-move-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "迁移演员");

    const head = document.createElement("header");
    head.className = "player-move-head";
    const title = document.createElement("h2");
    title.textContent = "迁移演员";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    head.append(title, close);

    const body = document.createElement("div");
    body.className = "player-move-body";

    const tabs = document.createElement("div");
    tabs.className = "player-move-tabs";
    const existingTab = document.createElement("button");
    existingTab.type = "button";
    existingTab.textContent = "已有人物";
    const createTab = document.createElement("button");
    createTab.type = "button";
    createTab.textContent = "新建人物";
    tabs.append(existingTab, createTab);

    const existingPane = document.createElement("div");
    existingPane.className = "player-move-pane";
    const existingInput = document.createElement("input");
    existingInput.type = "text";
    existingInput.placeholder = "输入人物姓名，例如：皆瀬あかり";
    existingInput.autocomplete = "off";
    existingInput.setAttribute("role", "combobox");
    existingInput.setAttribute("aria-autocomplete", "list");
    existingInput.setAttribute("aria-controls", "playerMovePersonResults");
    const existingResults = document.createElement("div");
    existingResults.id = "playerMovePersonResults";
    existingResults.className = "player-move-results";
    existingResults.setAttribute("role", "listbox");
    const existingHint = document.createElement("div");
    existingHint.className = "player-move-empty";
    existingPane.append(createMoveField("搜索人物", existingInput), existingResults, existingHint);

    const createPane = document.createElement("div");
    createPane.className = "player-move-pane";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "若葉結希";
    const javdbInput = document.createElement("input");
    javdbInput.type = "url";
    javdbInput.placeholder = "https://javdb.com/actors/...";
    const rootSelect = document.createElement("select");
    for (const root of roots) {
      const option = document.createElement("option");
      option.value = root;
      option.textContent = formatLibraryPath(root);
      rootSelect.append(option);
    }
    rootSelect.value = defaultRoot;
    const folderInput = document.createElement("input");
    folderInput.type = "text";
    folderInput.placeholder = "若葉結希";
    let folderTouched = false;
    nameInput.addEventListener("input", () => {
      if (!folderTouched) folderInput.value = safeFolderName(nameInput.value);
    });
    folderInput.addEventListener("input", () => {
      folderTouched = true;
    });
    createPane.append(
      createMoveField("演员名", nameInput),
      createMoveField("JavDB actor", javdbInput),
      createMoveField("保存硬盘", rootSelect),
      createMoveField("文件夹名", folderInput)
    );

    const status = document.createElement("div");
    status.className = "player-move-status";

    const foot = document.createElement("footer");
    foot.className = "player-move-foot";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "primary";
    submit.textContent = "迁移";
    foot.append(status, cancel, submit);

    let mode = "existing";
    let selectedExistingPerson = null;
    let visibleExistingPeople = [];
    const exactExistingMatches = () => {
      const query = normalizePersonSearchText(existingInput.value);
      if (!query) return [];
      return movePeople.filter((person) => movePersonSearchValues(person).includes(query));
    };
    const selectExistingPerson = (person) => {
      selectedExistingPerson = person || null;
      if (selectedExistingPerson) existingInput.value = selectedExistingPerson.name || selectedExistingPerson.actorProfile?.displayName || selectedExistingPerson.id;
      renderExistingPeople();
    };
    const renderExistingPeople = () => {
      const query = existingInput.value.trim();
      visibleExistingPeople = searchMovePeople(movePeople, query);
      const exactMatches = exactExistingMatches();
      if (exactMatches.length === 1) selectedExistingPerson = exactMatches[0];
      else if (selectedExistingPerson && !visibleExistingPeople.some((person) => person.id === selectedExistingPerson.id)) selectedExistingPerson = null;

      existingResults.innerHTML = "";
      for (const person of visibleExistingPeople) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "player-move-person-option";
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", person.id === selectedExistingPerson?.id ? "true" : "false");
        option.classList.toggle("selected", person.id === selectedExistingPerson?.id);
        const name = document.createElement("strong");
        name.textContent = person.actorProfile?.displayName || person.name || `人物 ${person.id}`;
        const meta = document.createElement("span");
        const workCount = Number(person.workCount || 0);
        meta.textContent = [formatLibraryPath(person.relativePath || ""), `${workCount} 部作品`].filter(Boolean).join(" · ");
        option.append(name, meta);
        option.addEventListener("click", () => selectExistingPerson(person));
        existingResults.append(option);
      }

      existingResults.hidden = visibleExistingPeople.length === 0;
      existingHint.hidden = visibleExistingPeople.length > 0;
      existingHint.textContent = query ? "没有找到匹配人物，可切换到“新建人物”" : "输入姓名后，从候选人物中选择";
      existingInput.setAttribute("aria-expanded", visibleExistingPeople.length > 0 ? "true" : "false");
      if (mode === "existing") {
        submit.disabled = !selectedExistingPerson;
        status.textContent = selectedExistingPerson
          ? `已选择：${selectedExistingPerson.actorProfile?.displayName || selectedExistingPerson.name}`
          : "";
      }
    };
    const renderMode = () => {
      existingTab.classList.toggle("active", mode === "existing");
      createTab.classList.toggle("active", mode === "create");
      existingPane.hidden = mode !== "existing";
      createPane.hidden = mode !== "create";
      status.textContent = "";
      submit.disabled = false;
      if (mode === "existing") renderExistingPeople();
      window.setTimeout(() => (mode === "existing" ? existingInput : nameInput).focus(), 0);
    };
    existingInput.addEventListener("input", () => {
      selectedExistingPerson = null;
      renderExistingPeople();
    });
    existingTab.addEventListener("click", () => {
      mode = "existing";
      renderMode();
    });
    createTab.addEventListener("click", () => {
      mode = "create";
      renderMode();
    });

    close.addEventListener("click", () => closeMoveDialog(overlay, null, resolve));
    cancel.addEventListener("click", () => closeMoveDialog(overlay, null, resolve));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeMoveDialog(overlay, null, resolve);
    });
    document.addEventListener("keydown", function onKey(event) {
      if (!overlay.isConnected) {
        document.removeEventListener("keydown", onKey);
        return;
      }
      if (event.key === "Escape") closeMoveDialog(overlay, null, resolve);
    });

    submit.addEventListener("click", async () => {
      status.textContent = "";
      if (mode === "existing") {
        let targetPerson = selectedExistingPerson;
        const personId = targetPerson?.id || parsePersonIdInput(existingInput.value);
        if (!personId) {
          status.textContent = existingInput.value.trim() ? "请从候选人物中选择" : "请输入人物姓名";
          return;
        }
        submit.disabled = true;
        try {
          if (!targetPerson) {
            targetPerson = movePeople.find((person) => String(person.id) === String(personId)) || null;
          }
          if (!targetPerson) {
            const data = await api(`/api/people/${encodeURIComponent(personId)}?limit=1`);
            targetPerson = data.person || null;
          }
          closeMoveDialog(overlay, { mode, personId, person: targetPerson }, resolve);
        } catch (error) {
          status.textContent = error.message || "读取目标人物失败";
          submit.disabled = false;
        }
        return;
      }

      const name = nameInput.value.trim();
      const folderName = safeFolderName(folderInput.value || name);
      if (!name) {
        status.textContent = "请填写演员名";
        return;
      }
      if (!rootSelect.value) {
        status.textContent = "请选择保存硬盘";
        return;
      }
      if (!folderName) {
        status.textContent = "文件夹名无效";
        return;
      }
      closeMoveDialog(
        overlay,
        {
          mode,
          createPerson: {
            name,
            displayName: name,
            javdbUrl: javdbInput.value.trim(),
            rootPath: rootSelect.value,
            folderName
          },
          person: {
            name,
            relativePath: `${rootSelect.value.replace(/[\\/]+$/, "")}/${folderName}`
          }
        },
        resolve
      );
    });

    body.append(tabs, existingPane, createPane);
    dialog.append(head, body, foot);
    overlay.append(dialog);
    document.body.append(overlay);
    renderMode();
  });
}

function createMoveField(labelText, control) {
  const label = document.createElement("label");
  label.className = "player-move-field";
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

async function moveCurrentWorkToPerson() {
  if (!els.moveToPerson || !currentWork?.id || currentWork.missingLocal || !isTrustedNetworkFeatureAvailable()) return;
  let target = null;
  try {
    target = await openMovePersonDialog();
  } catch (error) {
    showNotice(error.message || "打开迁移窗口失败");
    return;
  }
  if (!target) {
    return;
  }

  const pathText = formatLibraryPath(currentWork.relativePath || "");
  const targetPerson = target.person || null;
  const targetPath = formatLibraryPath(targetPerson?.relativePath || targetPerson?.sourcePaths?.[0] || "");
  const message = [
    "迁移这个作品到目标人物？",
    pathText,
    "",
    `目标人物：${targetPerson?.name || target.personId || target.createPerson?.name || ""}`,
    targetPath ? `目标文件夹：${targetPath}` : "",
    "",
    "会移动作品文件夹，并把这个作品分配给目标人物。"
  ].filter((line) => line !== "").join("\n");
  if (!window.confirm(message)) return;

  const originalText = els.moveToPerson.textContent;
  els.moveToPerson.disabled = true;
  els.moveToPerson.textContent = "释放播放";
  stopCurrentPlayback();
  await delay(1800);
  els.moveToPerson.textContent = "迁移中";
  try {
    const data = await api(`/api/works/${encodeURIComponent(currentWork.id)}/move-to-person`, {
      method: "POST",
      body: target.mode === "create" ? { createPerson: target.createPerson } : { personId: target.personId }
    });
    if (data.work) {
      currentWork = data.work;
      currentVideo = (currentWork.videos || []).find((video) => video.id === currentVideo?.id) || selectInitialVideo(currentWork);
      document.title = `${currentWork.title} - FanHao`;
      els.title.textContent = currentWork.title;
      renderFiles(currentWork);
      renderMeta(currentWork);
      updateMarkerButton();
      updateDeleteLocalButton();
      updateCorrectActorButton();
      updateMoveToPersonButton();
      updateOpenFileButton();
    }
    showNotice(`已迁移到：${data.person?.name || targetPerson?.name || target.personId || target.createPerson?.name}`);
  } catch (error) {
    els.moveToPerson.textContent = "迁移失败";
    els.moveToPerson.title = error.message || "迁移失败";
    showNotice(error.message || "迁移作品失败");
    window.setTimeout(() => {
      els.moveToPerson.textContent = originalText;
      els.moveToPerson.disabled = false;
      updateMoveToPersonButton();
    }, 2200);
  }
}

async function correctCurrentActorFromFolder() {
  if (!els.correctActor || !currentWork?.id || currentWork.missingLocal || !isTrustedNetworkFeatureAvailable()) return;
  const pathText = formatLibraryPath(currentWork.relativePath || "");
  const message = [
    "按本地文件夹订正演员？",
    pathText,
    "",
    "会把这个作品的演员关联替换成文件夹中的人物名，作品文件不会移动。"
  ].filter((line) => line !== "").join("\n");
  if (!window.confirm(message)) return;

  const originalText = els.correctActor.textContent;
  els.correctActor.disabled = true;
  els.correctActor.textContent = "订正中";
  try {
    const data = await api(`/api/works/${encodeURIComponent(currentWork.id)}/correct-actor-from-folder`, { method: "POST" });
    if (data.work) {
      currentWork = data.work;
      currentVideo = (currentWork.videos || []).find((video) => video.id === currentVideo?.id) || currentVideo;
      document.title = `${currentWork.title} - FanHao`;
      els.title.textContent = currentWork.title;
      renderFiles(currentWork);
      renderMeta(currentWork);
      updateMarkerButton();
      updateDeleteLocalButton();
      updateCorrectActorButton();
      updateMoveToPersonButton();
    }
    showNotice(`演员已订正为：${data.actorName || data.person?.name || "文件夹人物"}`);
    window.setTimeout(() => {
      if (currentVideo) {
        els.notice.hidden = true;
        els.video.hidden = false;
      }
    }, 1800);
  } catch (error) {
    els.correctActor.textContent = "订正失败";
    els.correctActor.title = error.message || "订正失败";
    showNotice(error.message || "订正演员失败");
    window.setTimeout(() => {
      els.correctActor.textContent = originalText;
      els.correctActor.disabled = false;
      updateCorrectActorButton();
    }, 2200);
  }
}

async function deleteCurrentLocalFiles() {
  if (!els.deleteLocal || !currentWork?.id || currentWork.missingLocal || currentWork.galleryMedia || !isTrustedNetworkFeatureAvailable()) return;
  const title = currentWork.title || currentWork.directoryName || currentWork.id;
  const pathText = formatLibraryPath(currentWork.relativePath || "");
  const message = [
    `确认删除这个作品的本地文件夹？`,
    title,
    pathText,
    "",
    "数据库资料会保留，删除后会显示为未下载。"
  ].filter((line) => line !== "").join("\n");
  if (!window.confirm(message)) return;

  stopCurrentPlayback();
  await delay(700);
  const originalText = els.deleteLocal.textContent;
  els.deleteLocal.disabled = true;
  els.deleteLocal.textContent = "删除中";
  try {
    const data = await api(`/api/works/${encodeURIComponent(currentWork.id)}/local-files/delete`, { method: "POST" });
    currentWork = data.work || { ...currentWork, missingLocal: true, videos: [], images: [], infos: [] };
    currentVideo = null;
    document.title = `${currentWork.title || title} - FanHao`;
    els.title.textContent = currentWork.title || title;
    renderFiles(currentWork);
    renderMeta(currentWork);
    updateMarkerButton();
    updateOpenFileButton();
    updateDeleteLocalButton();
    const removedEmpty = Array.isArray(data.emptyRemovedPaths) && data.emptyRemovedPaths.length
      ? `，已清理 ${data.emptyRemovedPaths.length} 个空文件夹`
      : "";
    showNotice(`本地文件已删除${removedEmpty}，这个作品现在是未下载状态`);
  } catch (error) {
    els.deleteLocal.textContent = "删除失败";
    els.deleteLocal.title = error.message || "删除失败";
    showNotice(error.message || "删除本地文件失败");
    window.setTimeout(() => {
      els.deleteLocal.textContent = originalText;
      els.deleteLocal.disabled = false;
      updateDeleteLocalButton();
    }, 2200);
  }
}

function stopCurrentPlayback() {
  stopProgressTimer();
  currentVideo = null;
  currentPlayInfo = null;
  playbackOffset = 0;
  isSeeking = false;
  streamNeedsActivation = false;
  setStreamPending(false);
  try {
    els.video.pause();
    els.video.srcObject = null;
    els.video.removeAttribute("src");
    els.video.querySelectorAll("source").forEach((source) => source.remove());
    els.video.load();
  } catch {
    // Nothing to do if the browser already released the media element.
  }
  els.video.hidden = true;
  hidePlaybackControls();
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isLocalFileOpenAvailable() {
  return isTrustedNetworkFeatureAvailable();
}

function isTrustedNetworkFeatureAvailable() {
  const host = normalizeHostname(window.location.hostname);
  return isLocalHostName(host) || isPrivateLanHost(host);
}

function normalizeHostname(host) {
  return String(host || "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function isLocalHostName(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(normalizeHostname(host));
}

function isPrivateLanHost(host) {
  const value = normalizeHostname(host);
  if (value.endsWith(".local")) return true;
  if (value.startsWith("fe80:") || (value.includes(":") && (value.startsWith("fc") || value.startsWith("fd")))) return true;

  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.hidden = false;
  els.video.hidden = true;
  hidePlaybackControls();
}

function startProgressTimer() {
  progressTimer = window.setInterval(reportProgress, 5000);
}

function stopProgressTimer() {
  if (!progressTimer) return;
  window.clearInterval(progressTimer);
  progressTimer = null;
}

function reportProgress(positionOverride = null, options = {}) {
  const duration = mediaDuration();
  if (!currentVideo || !els.video || !duration) return;
  const now = Date.now();
  if (!options.force && now - lastProgressReport < 1000) return;
  lastProgressReport = now;
  api(`/api/progress/${encodeURIComponent(currentVideo.id)}`, {
    method: "POST",
    body: {
      workId: currentWork?.id || "",
      position: positionOverride == null ? mediaPosition() : clampSeekTime(positionOverride),
      duration
    }
  }).catch(() => {});
}

function formatLibraryPath(value) {
  return String(value || "").replaceAll("\\", "/");
}
