// 播放引擎：独占 <audio> 元素、WebAudio 可视化、MediaSession、进度跳转、睡眠定时。
// 这是音乐模块里唯一允许直接创建/操作 audio 的地方。
// 通过 callbacks 把“UI 更新”回交给组合根（music-page.js），自身不持有任何 DOM 渲染状态。

import { normalizePlaybackSpeed } from "../format.js";
import { MUSIC_VISUALIZER_FRAME_MS } from "../constants.js";
import { captureWebAccount } from "../../../platform/accounts/session-context.js";

/**
 * @param {object} options
 * @param {() => object} options.getState  返回宿主全局 state（需含 .music 与 .activeView）
 * @param {object} options.callbacks  UI 更新回调
 *   onPlay / onPause / onTimeUpdate / onEnded / onError(message)
 *   onSleepTimerChange() / onSaveProgress() / onLyricFollowResume()
 */
export function createMusicPlayer({ getState, callbacks = {} }) {
  const music = () => getState().music;
  const activeView = () => getState().activeView;

  let audio = null;
  let audioEventsInstalled = false;
  let playGeneration = 0;
  let metadataLoaded = false;
  let restoreSavedPosition = false;
  let retryPosition = null;
  let sourceDiscarded = false;
  let audioContext = null;
  let audioAnalyser = null;
  let audioSource = null;

  let visualizerCanvas = null;
  let visualizerRaf = 0;
  let visualizerBins = null;
  let visualizerLastFrameAt = 0;

  let mediaSessionInstalled = false;
  let mediaSessionPositionSecond = -1;
  let mediaSessionPlaybackState = "";

  let sleepTimerTimeout = 0;
  let sleepTimerInterval = 0;

  // ---- audio 元素与事件 ----
  function ensureAudio() {
    if (!audio) {
      audio = new Audio();
      audio.preload = "metadata";
      audio.volume = readVolumePreferenceLocal();
      applyPlaybackRate(music().playbackSpeed ?? readPlaybackSpeedPreferenceLocal());
    }
    if (audioEventsInstalled) return;
    audioEventsInstalled = true;
    audio.addEventListener("play", () => {
      if (discardStaleRetry() || sourceDiscarded || audio.paused || audio.error) return;
      music().playing = true;
      startVisualizer();
      callbacks.onPlay && callbacks.onPlay();
    });
    audio.addEventListener("pause", () => {
      if (discardStaleRetry() || sourceDiscarded || !audio.paused) return;
      playGeneration += 1;
      music().playing = false;
      stopVisualizer({ draw: true });
      callbacks.onPause && callbacks.onPause();
    });
    audio.addEventListener("loadedmetadata", () => {
      if (discardStaleRetry() || sourceDiscarded || !audio.src || !music().current || audio.error || audio.readyState === 0 || (audio.currentSrc && audio.currentSrc !== audio.src)) return;
      metadataLoaded = true;
      const pending = retryPosition;
      retryPosition = null;
      const position = pending ? pending.position : Number(music().current?.positionMs || 0) / 1000;
      const restore = pending || restoreSavedPosition;
      restoreSavedPosition = false;
      const resumeLimit = audio.duration - (pending ? 0 : 3);
      if (restore && position > 0 && Number.isFinite(audio.duration) && position < resumeLimit) {
        audio.currentTime = position;
      }
      callbacks.onTimeUpdate && callbacks.onTimeUpdate();
    });
    audio.addEventListener("timeupdate", () => {
      if (discardStaleRetry() || sourceDiscarded) return;
      callbacks.onTimeUpdate && callbacks.onTimeUpdate();
    });
    audio.addEventListener("ended", () => {
      if (discardStaleRetry() || sourceDiscarded) return;
      callbacks.onEnded && callbacks.onEnded();
    });
    audio.addEventListener("error", () => {
      // A queued error from a discarded resource no longer owns this element.
      if (discardStaleRetry() || sourceDiscarded || !audio.error || !audio.src || !music().current) return;
      playGeneration += 1;
      // Native media failures can leave paused=false. Normalize that state so
      // the next press of the playback control expresses a retry.
      if (!audio.paused) audio.pause();
      music().playing = false;
      stopVisualizer({ draw: true });
      callbacks.onError && callbacks.onError("音频播放失败，可再次播放重试，或检查网络与音频格式");
    });
    installMediaSessionHandlers();
  }

  function play() {
    ensureAudio();
    discardStaleRetry();
    sourceDiscarded = false;
    ensureAudioGraph();
    const generation = ++playGeneration;
    const source = audio.src;
    const trackId = music().current?.id || "";
    if (audio.error && source && trackId) {
      // play() alone cannot recover a terminal MediaError. Reload only on an
      // explicit play intent, retaining the same track and its listening point.
      const position = retryPosition && isRetryPositionCurrent(retryPosition) ? retryPosition.position
        : metadataLoaded || !restoreSavedPosition ? Number(audio.currentTime || 0) : Number(music().current?.positionMs || 0) / 1000;
      retryPosition = { source, trackId, position, account: captureWebAccount() };
      metadataLoaded = false;
      applyPlaybackRate(music().playbackSpeed);
      audio.load();
      // Preserve the default start position before metadata too: a pause or
      // progress flush during the reload must not persist its unloaded zero.
      if (Number.isFinite(position) && position > 0) audio.currentTime = position;
    }
    audio.play().catch((error) => {
      // A source change or a later playback intent can reject an older play().
      // That promise no longer owns the current track's error surface.
      if (generation !== playGeneration || audio.src !== source || (music().current?.id || "") !== trackId) return;
      callbacks.onError && callbacks.onError(error?.message || "浏览器阻止了自动播放");
    });
  }

  function isRetryPositionCurrent(pending) {
    if (audio.src !== pending.source || music().current?.id !== pending.trackId) return false;
    try {
      const account = captureWebAccount();
      return account.owner === pending.account.owner && account.revision === pending.account.revision;
    } catch { return false; }
  }

  function discardStaleRetry() {
    if (!retryPosition || isRetryPositionCurrent(retryPosition)) return false;
    // The default start is already installed. Clear it and silence queued
    // media callbacks before pausing, so they cannot save for a new account.
    retryPosition = null;
    sourceDiscarded = true;
    playGeneration += 1;
    audio.currentTime = 0;
    audio.pause();
    music().playing = false;
    stopVisualizer({ draw: true });
    callbacks.onError && callbacks.onError("");
    return true;
  }

  function pause() {
    ensureAudio();
    playGeneration += 1;
    audio.pause();
  }

  function load(track, autoplay) {
    ensureAudio();
    sourceDiscarded = false;
    // An initial seek also installs a native default start. It must not carry
    // into a replacement track, even when both tracks share the same URL.
    const resettingStart = Boolean(retryPosition) || Boolean(audio.src && !metadataLoaded && !restoreSavedPosition && audio.readyState === 0);
    playGeneration += 1;
    metadataLoaded = false;
    retryPosition = null;
    restoreSavedPosition = true;
    const target = new URL(track.streamUrl, window.location.href).href;
    applyPlaybackRate(music().playbackSpeed);
    if (audio.src !== target || resettingStart) {
      audio.src = target;
      audio.load();
      if (resettingStart) audio.currentTime = 0;
    }
    callbacks.onError && callbacks.onError("");
    updateMediaSession();
    if (autoplay) play();
  }

  function seek(seconds) {
    ensureAudio();
    // A user seek owns this load's start point, including an explicit zero.
    // Native Audio retains that default start until metadata becomes ready.
    restoreSavedPosition = false;
    const position = Number(seconds || 0);
    if (retryPosition && isRetryPositionCurrent(retryPosition)) retryPosition.position = position;
    audio.currentTime = position;
  }

  function getAudio() {
    ensureAudio();
    return audio;
  }

  function setVolume(value) {
    ensureAudio();
    audio.volume = Math.max(0, Math.min(1, Number(value || 0)));
  }

  function setRate(value) {
    ensureAudio();
    applyPlaybackRate(value);
  }

  function applyPlaybackRate(value) {
    const rate = normalizePlaybackSpeed(value);
    // Native load() resets playbackRate to defaultPlaybackRate. Keep the
    // selected speed through source selection and explicit failure recovery.
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
  }

  // ---- WebAudio 图（可视化数据源）----
  function ensureAudioGraph() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !audio) return;
    try {
      if (!audioContext) audioContext = new AudioContextClass();
      if (!audioAnalyser) {
        audioAnalyser = audioContext.createAnalyser();
        audioAnalyser.fftSize = 128;
        audioAnalyser.smoothingTimeConstant = 0.82;
      }
      if (!audioSource) {
        audioSource = audioContext.createMediaElementSource(audio);
        audioSource.connect(audioAnalyser);
        audioAnalyser.connect(audioContext.destination);
      }
      if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
    } catch {}
  }

  // ---- 可视化 ----
  function setVisualizerCanvas(canvas) {
    visualizerCanvas = canvas;
  }

  function startVisualizer() {
    stopVisualizer();
    if (activeView() !== "music" || !visualizerCanvas?.isConnected || !music().trackPageOpen || !audio || audio.paused || document.hidden) {
      if (visualizerCanvas) visualizerCanvas.dataset.visualizerRunning = "false";
      drawVisualizer();
      return;
    }
    visualizerCanvas.dataset.visualizerRunning = "true";
    const tick = (timestamp = 0) => {
      if (activeView() !== "music" || !visualizerCanvas?.isConnected || !music().trackPageOpen || !audio || audio.paused || document.hidden) {
        if (visualizerCanvas) visualizerCanvas.dataset.visualizerRunning = "false";
        visualizerRaf = 0;
        return;
      }
      if (!visualizerLastFrameAt || timestamp - visualizerLastFrameAt >= MUSIC_VISUALIZER_FRAME_MS) {
        visualizerLastFrameAt = timestamp;
        drawVisualizer();
      }
      visualizerRaf = window.requestAnimationFrame(tick);
    };
    visualizerRaf = window.requestAnimationFrame(tick);
  }

  function stopVisualizer({ draw = false } = {}) {
    if (visualizerRaf) window.cancelAnimationFrame(visualizerRaf);
    visualizerRaf = 0;
    visualizerLastFrameAt = 0;
    if (visualizerCanvas) visualizerCanvas.dataset.visualizerRunning = "false";
    if (draw) drawVisualizer();
  }

  function drawVisualizer() {
    const canvas = visualizerCanvas;
    if (activeView() !== "music" || !canvas?.isConnected) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    if (audioAnalyser && (!visualizerBins || visualizerBins.length !== audioAnalyser.frequencyBinCount)) {
      visualizerBins = new Uint8Array(audioAnalyser.frequencyBinCount);
    }
    const bins = audioAnalyser ? visualizerBins : null;
    if (bins) audioAnalyser.getByteFrequencyData(bins);
    const barCount = Math.min(72, Math.max(36, Math.floor(rect.width / 13)));
    const gap = Math.max(3, width * 0.0038);
    const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
    const gradient = context.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, "rgba(24, 213, 125, 0.08)");
    gradient.addColorStop(0.4, "rgba(24, 213, 125, 0.8)");
    gradient.addColorStop(1, "rgba(88, 241, 166, 1)");
    context.fillStyle = gradient;
    for (let index = 0; index < barCount; index += 1) {
      const sourceIndex = bins ? Math.min(bins.length - 1, Math.floor((index / barCount) * bins.length * 0.78)) : 0;
      const level = bins ? bins[sourceIndex] / 255 : 0;
      const idle = audio && !audio.paused ? 0.08 : 0.025;
      const barHeight = Math.max(2 * ratio, (idle + level * 0.92) * height);
      const x = index * (barWidth + gap);
      context.fillRect(x, height - barHeight, barWidth, barHeight);
    }
  }

  // ---- 跳转 ----
  function seekRelative(offsetSeconds) {
    ensureAudio();
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(music().current?.durationMs || 0) / 1000;
    const target = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(audio.currentTime || 0) + Number(offsetSeconds || 0)));
    seek(target);
    callbacks.onTimeUpdate && callbacks.onTimeUpdate();
  }

  function seekToLyricLine(timeMs) {
    ensureAudio();
    const nextTime = Math.max(0, Number(timeMs || 0) / 1000);
    if (!Number.isFinite(nextTime)) return;
    music().lyricFollowPaused = false;
    callbacks.onLyricFollowResume && callbacks.onLyricFollowResume();
    seek(nextTime);
    callbacks.onTimeUpdate && callbacks.onTimeUpdate();
  }

  // ---- MediaSession ----
  function installMediaSessionHandlers() {
    if (mediaSessionInstalled || !supportsMediaSession()) return;
    mediaSessionInstalled = true;
    setMediaAction("play", () => callbacks.onMediaPlay && callbacks.onMediaPlay());
    setMediaAction("pause", () => callbacks.onMediaPause && callbacks.onMediaPause());
    setMediaAction("previoustrack", () => callbacks.onMediaPrev && callbacks.onMediaPrev());
    setMediaAction("nexttrack", () => callbacks.onMediaNext && callbacks.onMediaNext());
    setMediaAction("seekbackward", (details = {}) => {
      const offset = Number(details.seekOffset || 10);
      if (callbacks.onMediaSeekBackward) callbacks.onMediaSeekBackward(offset);
      else seekRelative(-offset);
    });
    setMediaAction("seekforward", (details = {}) => {
      const offset = Number(details.seekOffset || 10);
      if (callbacks.onMediaSeekForward) callbacks.onMediaSeekForward(offset);
      else seekRelative(offset);
    });
    setMediaAction("seekto", (details = {}) => {
      if (typeof details.seekTime !== "number") return;
      if (callbacks.onMediaSeekTo) { callbacks.onMediaSeekTo(details.seekTime); return; }
      seek(details.seekTime);
      callbacks.onTimeUpdate && callbacks.onTimeUpdate();
    });
  }

  function setMediaAction(action, handler) {
    const session = getMediaSession();
    if (!session) return;
    try {
      session.setActionHandler(action, handler);
    } catch {}
  }

  function updateMediaSession(duration = 0, current = 0) {
    const session = getMediaSession();
    if (!session) return;
    const track = music().current;
    if (!track) {
      music().mediaSessionTrackId = "";
      mediaSessionPositionSecond = -1;
      mediaSessionPlaybackState = "none";
      session.playbackState = "none";
      return;
    }
    if (music().mediaSessionTrackId !== track.id) {
      music().mediaSessionTrackId = track.id;
      mediaSessionPositionSecond = -1;
      if (typeof window !== "undefined" && "MediaMetadata" in window) {
        session.metadata = new window.MediaMetadata({
          title: track.title || "未知歌曲",
          artist: track.artist || "未知歌手",
          album: track.album || "未知专辑",
          artwork: mediaArtworkForTrack(track)
        });
      }
    }
    const playing = Boolean(audio && !audio.paused);
    music().playing = playing;
    const playbackState = playing ? "playing" : "paused";
    const positionSecond = Math.max(0, Math.min(Math.floor(duration), Math.floor(current || 0)));
    if (mediaSessionPlaybackState !== playbackState) {
      mediaSessionPlaybackState = playbackState;
      session.playbackState = playbackState;
    }
    if (typeof session.setPositionState === "function" && duration > 0 && mediaSessionPositionSecond !== positionSecond) {
      try {
        session.setPositionState({
          duration,
          playbackRate: audio?.playbackRate || 1,
          position: Math.max(0, Math.min(duration, current || 0))
        });
        mediaSessionPositionSecond = positionSecond;
      } catch {}
    }
  }

  function mediaArtworkForTrack(track) {
    if (!track?.coverUrl) return [];
    try {
      return [{ src: new URL(track.coverUrl, window.location.href).href, sizes: "512x512" }];
    } catch {
      return [];
    }
  }

  function supportsMediaSession() {
    return Boolean(getMediaSession());
  }

  function getMediaSession() {
    if (typeof navigator !== "undefined" && navigator.mediaSession) return navigator.mediaSession;
    if (typeof window !== "undefined" && window.navigator?.mediaSession) return window.navigator.mediaSession;
    return null;
  }

  // ---- 可见性 ----
  function installVisibilityHandler() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        callbacks.onSaveProgress && callbacks.onSaveProgress();
        stopVisualizer();
      } else if (audio && !audio.paused) {
        startVisualizer();
      } else {
        drawVisualizer();
      }
    });
  }

  // ---- 睡眠定时 ----
  function syncSleepTimer() {
    if (!sleepTimerActive()) {
      music().sleepMinutes = 0;
      music().sleepUntil = 0;
    } else if (!sleepTimerTimeout) {
      scheduleSleepTimer();
    }
  }

  function setSleepTimer(minutes) {
    const normalized = normalizeSleepTimerMinutesLocal(minutes);
    clearSleepTimerHandle();
    if (!normalized) {
      music().sleepMinutes = 0;
      music().sleepUntil = 0;
      music().status = "已关闭睡眠定时";
      callbacks.onSleepTimerChange && callbacks.onSleepTimerChange();
      return;
    }
    music().sleepMinutes = normalized;
    music().sleepUntil = Date.now() + normalized * 60 * 1000;
    music().status = `将在 ${normalized} 分钟后暂停`;
    scheduleSleepTimer();
    callbacks.onSleepTimerChange && callbacks.onSleepTimerChange();
  }

  function scheduleSleepTimer() {
    clearSleepTimerHandle();
    const remaining = sleepTimerRemainingMs();
    if (remaining <= 0) {
      expireSleepTimer();
      return;
    }
    sleepTimerTimeout = window.setTimeout(expireSleepTimer, Math.min(remaining, 2147483647));
    sleepTimerInterval = window.setInterval(() => {
      if (!sleepTimerActive()) {
        clearSleepTimerHandle();
        return;
      }
      if (sleepTimerRemainingMs() <= 0) {
        expireSleepTimer();
        return;
      }
      callbacks.onSleepTimerChange && callbacks.onSleepTimerChange();
    }, 30000);
  }

  function clearSleepTimerHandle() {
    if (sleepTimerTimeout) {
      window.clearTimeout(sleepTimerTimeout);
      sleepTimerTimeout = 0;
    }
    if (sleepTimerInterval) {
      window.clearInterval(sleepTimerInterval);
      sleepTimerInterval = 0;
    }
  }

  function expireSleepTimer() {
    clearSleepTimerHandle();
    music().sleepMinutes = 0;
    music().sleepUntil = 0;
    ensureAudio();
    if (!audio.paused) pause();
    music().status = "睡眠定时已暂停播放";
    callbacks.onSleepTimerChange && callbacks.onSleepTimerChange();
  }

  function sleepTimerActive() {
    return sleepTimerRemainingMs() > 0;
  }

  function sleepTimerRemainingMs() {
    return Math.max(0, Number(music().sleepUntil || 0) - Date.now());
  }

  function sleepTimerText() {
    const minutes = Math.max(1, Math.ceil(sleepTimerRemainingMs() / 60000));
    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
    }
    return `${minutes} 分钟`;
  }

  // 偏好读取的本地化副本（避免与 prefs.js 的 window.localStorage 直接耦合，方便无 DOM 环境单测）
  function readVolumePreferenceLocal() {
    try {
      const value = Number(window.localStorage?.getItem("fanhao.music.volume") || 0.82);
      return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.82;
    } catch {
      return 0.82;
    }
  }

  function readPlaybackSpeedPreferenceLocal() {
    try {
      return normalizePlaybackSpeed(window.localStorage?.getItem("fanhao.music.playbackSpeed"));
    } catch {
      return 1;
    }
  }

  function normalizeSleepTimerMinutesLocal(value) {
    const minutes = Math.round(Number(value || 0));
    return [0, 10, 15, 30, 45, 60, 90].includes(minutes) ? minutes : 0;
  }

  return {
    ensureAudio,
    play,
    pause,
    load,
    seek,
    getAudio,
    setVolume,
    setRate,
    setVisualizerCanvas,
    startVisualizer,
    stopVisualizer,
    drawVisualizer,
    seekRelative,
    seekToLyricLine,
    installMediaSessionHandlers,
    installVisibilityHandler,
    updateMediaSession,
    syncSleepTimer,
    setSleepTimer,
    sleepTimerActive,
    sleepTimerText
  };
}
