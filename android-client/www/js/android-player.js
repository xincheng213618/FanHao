import { fetchJson, postJson } from "./api.js?v=20260702-novel-local-manage-74";
import { formatBytes, formatNumber, formatTime } from "./format.js";
import { absoluteUrl } from "./image.js";
import { createDetailSectionTitle, revealDetailBlock } from "./detail-ui.js";

export function createAndroidVideoSection(context) {
  const { getActiveUrl } = context;

  function createVideoList(work, options = {}) {
    const showFiles = options.showFiles !== false;
    const showTitle = options.showTitle !== false;
    const section = document.createElement("div");
    section.className = "detail-block";
    if (showTitle) section.append(createDetailSectionTitle(options.title || "视频文件", formatNumber(work.videos?.length || 0)));

    const playerMount = document.createElement("div");
    playerMount.className = "android-player-mount";
    section.append(playerMount);

    if (!showFiles) return section;

    const list = document.createElement("div");
    list.className = "file-list";
    for (const video of work.videos || []) {
      const row = document.createElement("div");
      row.className = "file-row";
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = video.title || video.name;
      const meta = document.createElement("span");
      const progress = video.progress?.percent ? ` · 看到 ${Math.floor(video.progress.percent)}%` : "";
      meta.textContent = `${video.ext || ""} · ${formatBytes(video.size)}${progress}`;
      info.append(title, meta);

      const play = document.createElement("button");
      play.type = "button";
      play.textContent = video.progress?.percent ? "继续播放" : "播放";
      play.addEventListener("click", () => {
        playVideo(playerMount, work, video, { autoplay: true });
      });
      row.append(info, play);
      list.append(row);
    }

    if (!work.videos?.length) {
      const empty = document.createElement("div");
      empty.className = "message-box quiet";
      empty.textContent = "这个作品没有视频文件。";
      list.append(empty);
    }

    section.append(list);
    return section;
  }

  async function playDefaultVideo(section, work) {
    const mount = section?.querySelector(".android-player-mount");
    const video = selectDefaultVideo(work);
    if (!mount || !video) return false;
    await playVideo(mount, work, video, { autoplay: true });
    return true;
  }

  function selectDefaultVideo(work) {
    const videos = work.videos || [];
    return videos.find((video) => video.progress?.percent) || videos.find((video) => video.playable) || videos[0] || null;
  }

  async function playVideo(mount, work, videoFile, options = {}) {
    const activeUrl = getActiveUrl();
    const resume = Number(options.startAt ?? videoFile.progress?.position ?? 0);
    mount.innerHTML = `<div class="loading-row">正在准备播放</div>`;
    revealDetailBlock(mount);

    let playInfo = null;
    try {
      playInfo = await fetchJson(activeUrl, `/api/playinfo/${encodeURIComponent(videoFile.id)}`);
    } catch (error) {
      mount.innerHTML = "";
      mount.append(createPlayerErrorBox(error.message || "播放地址准备失败，请重试", {
        retry: () => playVideo(mount, work, videoFile, options)
      }));
      revealDetailBlock(mount);
      return;
    }

    const opened = await openNativePlayer(activeUrl, work, videoFile, playInfo, resume);
    if (opened) {
      mount.innerHTML = "";
      return;
    }

    return renderAndroidPlayer(mount, work, videoFile, { ...options, playInfo, startAt: resume });
  }

  async function openNativePlayer(activeUrl, work, videoFile, playInfo, resume) {
    const plugin = nativePlayerPlugin();
    if (!plugin?.play) return false;

    const directUrl = absoluteUrl(activeUrl, `/media/video/${encodeURIComponent(videoFile.id)}`);
    const fallbackOffset = playInfo?.mode === "direct" ? 0 : resume;
    const fallbackUrl = playInfo ? streamUrlFor(activeUrl, playInfo, fallbackOffset) : "";
    const progressUrl = absoluteUrl(activeUrl, `/api/progress/${encodeURIComponent(videoFile.id)}`);
    const subtitle = [work.personDisplayName || work.personName, videoFile.ext, playInfo ? playModeText(playInfo) : "直连播放"].filter(Boolean).join(" · ");

    try {
      await plugin.play({
        url: directUrl,
        fallbackUrl,
        title: work.title || work.directoryName || videoFile.title || videoFile.name || "播放",
        subtitle,
        progressUrl,
        workId: work.id,
        videoId: videoFile.id,
        mode: playInfo?.mode || "native-direct",
        position: resume,
        duration: Number(playInfo?.duration || videoFile.progress?.duration || 0)
      });
      return true;
    } catch {
      return false;
    }
  }

  function nativePlayerPlugin() {
    return window.Capacitor?.Plugins?.FanHaoPlayer || null;
  }

  async function renderAndroidPlayer(mount, work, videoFile, options = {}) {
    const activeUrl = getActiveUrl();
    if (!options.playInfo) {
      mount.innerHTML = `<div class="loading-row">正在探测播放方式</div>`;
      revealDetailBlock(mount);
    }
    try {
      const playInfo = options.playInfo || await fetchJson(activeUrl, `/api/playinfo/${encodeURIComponent(videoFile.id)}`);
      const isSegmentedStream = playInfo.mode !== "direct";
      const resume = Number(options.startAt ?? videoFile.progress?.position ?? 0);
      const streamOffset = isSegmentedStream ? Math.max(0, resume) : 0;
      mount.innerHTML = "";
      const playerShell = document.createElement("div");
      playerShell.className = "android-player-shell";

      const video = document.createElement("video");
      video.controls = !isSegmentedStream;
      video.preload = "metadata";
      video.playsInline = true;
      video.src = streamUrlFor(activeUrl, playInfo, streamOffset);
      if (playInfo.mode === "direct" && resume > 5) {
        video.addEventListener("loadedmetadata", () => {
          if (resume < video.duration - 8) video.currentTime = resume;
        }, { once: true });
      }

      const label = document.createElement("div");
      label.className = "player-mode-label";
      const duration = playInfo.duration ? ` · ${formatTime(playInfo.duration)}` : "";
      const codec = [playInfo.videoCodec, playInfo.audioCodec].filter(Boolean).join(" / ") || videoFile.ext || "video";
      label.textContent = `${playModeText(playInfo)} · ${codec}${duration}`;

      const status = document.createElement("div");
      status.className = "player-status";
      status.textContent = isSegmentedStream && streamOffset > 0
        ? `从 ${formatTime(streamOffset)} 继续`
        : options.autoplay ? "正在启动播放" : "点播放键开始";
      const actions = document.createElement("div");
      actions.className = "player-action-row";

      let lastReportedAt = 0;
      const report = (force = false) => {
        const duration = timelineDuration(video, playInfo, streamOffset);
        if (!duration || Number.isNaN(duration)) return;
        const now = Date.now();
        if (!force && now - lastReportedAt < 5000 && !video.paused) return;
        lastReportedAt = now;
        postJson(activeUrl, `/api/progress/${encodeURIComponent(videoFile.id)}`, {
          workId: work.id,
          position: currentPlaybackPosition(video, streamOffset),
          duration
        }).catch(() => {});
      };
      video.addEventListener("timeupdate", report);
      video.addEventListener("pause", () => report(true));
      video.addEventListener("ended", () => report(true));
      video.addEventListener("play", () => {
        status.textContent = "正在播放";
        actions.replaceChildren();
      });
      video.addEventListener("pause", () => {
        if (!video.ended) status.textContent = "已暂停";
      });
      video.addEventListener("ended", () => {
        status.textContent = "播放结束";
      });
      video.addEventListener("error", () => {
        const message = videoErrorText(video);
        if (playInfo.mode === "direct" && !options.fallbackTried) {
          status.textContent = "直连失败，正在切换智能播放";
          const fallbackInfo = fallbackPlayInfo(playInfo, videoFile);
          window.setTimeout(() => {
            renderAndroidPlayer(mount, work, videoFile, {
              ...options,
              autoplay: true,
              fallbackTried: true,
              playInfo: fallbackInfo,
              startAt: currentPlaybackPosition(video, 0) || resume
            });
          }, 250);
          return;
        }
        status.textContent = message;
        actions.replaceChildren(
          createPlayerButton("重试", () => renderAndroidPlayer(mount, work, videoFile, { autoplay: true, startAt: resume })),
          ...(playInfo.mode === "remux"
            ? [createPlayerButton("强制转码", () => renderAndroidPlayer(mount, work, videoFile, {
              autoplay: true,
              playInfo: transcodePlayInfo(playInfo, videoFile),
              startAt: currentPlaybackPosition(video, streamOffset) || resume
            }))]
            : [])
        );
      });

      playerShell.append(video, label, status, actions);
      if (isSegmentedStream) {
        playerShell.append(createSegmentedControls({
          video,
          playInfo,
          streamOffset,
          status,
          onSeek: (nextPosition, autoplay) => {
            report(true);
            renderAndroidPlayer(mount, work, videoFile, {
              ...options,
              autoplay,
              playInfo,
              startAt: nextPosition
            });
          }
        }));
      }
      mount.append(playerShell);
      revealDetailBlock(mount);

      if (options.autoplay) {
        video.play().catch(() => {
          status.textContent = "手机系统拦截了自动播放，请点一下画面继续";
          actions.replaceChildren(
            createPlayerButton("继续播放", () => {
              video.play().catch(() => {
                status.textContent = "仍无法自动播放，请直接点画面";
              });
            })
          );
        });
      }
    } catch (error) {
      mount.innerHTML = "";
      mount.append(createPlayerErrorBox(error.message, {
        retry: () => renderAndroidPlayer(mount, work, videoFile, { autoplay: true })
      }));
      revealDetailBlock(mount);
    }
  }

  function streamUrlFor(activeUrl, playInfo, startAt) {
    const url = new URL(absoluteUrl(activeUrl, playInfo.streamUrl));
    if (playInfo.mode !== "direct" && startAt > 0) {
      url.searchParams.set("t", String(Math.floor(startAt)));
    }
    return url.toString();
  }

  function playModeText(playInfo) {
    if (playInfo.mode === "direct") return "直连播放";
    if (playInfo.mode === "remux") return "快速重封装";
    return playInfo.label || "智能转码";
  }

  function timelineDuration(video, playInfo, streamOffset) {
    const probed = Number(playInfo.duration || 0);
    if (Number.isFinite(probed) && probed > 0) return probed;
    const nativeDuration = Number(video.duration || 0);
    return Number.isFinite(nativeDuration) && nativeDuration > 0 ? nativeDuration + streamOffset : 0;
  }

  function currentPlaybackPosition(video, streamOffset) {
    return Math.max(0, Number(streamOffset || 0) + Number(video.currentTime || 0));
  }

  function fallbackPlayInfo(playInfo, videoFile) {
    const canCopyVideo = playInfo.videoCodec === "h264";
    const mode = canCopyVideo ? "remux" : "transcode";
    const params = new URLSearchParams({
      mode,
      audio: playInfo.audioCodec === "aac" ? "copy" : "aac"
    });
    return {
      ...playInfo,
      mode,
      label: mode === "remux" ? "快速重封装" : "智能转码",
      streamUrl: `/media/video/${encodeURIComponent(videoFile.id)}/transcode?${params}`
    };
  }

  function transcodePlayInfo(playInfo, videoFile) {
    const params = new URLSearchParams({
      mode: "transcode",
      audio: "aac"
    });
    return {
      ...playInfo,
      mode: "transcode",
      label: playInfo.hasNvenc ? "GPU 转码" : "智能转码",
      streamUrl: `/media/video/${encodeURIComponent(videoFile.id)}/transcode?${params}`
    };
  }

  function videoErrorText(video) {
    const code = video.error?.code;
    if (code === 1) return "播放已取消";
    if (code === 2) return "网络中断，视频加载失败";
    if (code === 3) return "手机无法解码，建议切换智能播放";
    if (code === 4) return "当前格式不支持播放";
    return "视频播放失败";
  }

  function createPlayerButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function createPlayerErrorBox(message, handlers) {
    const box = document.createElement("div");
    box.className = "message-box error player-error-box";
    const text = document.createElement("strong");
    text.textContent = message || "播放失败";
    const actionRow = document.createElement("div");
    actionRow.className = "player-action-row error-actions";
    actionRow.append(createPlayerButton("重试", handlers.retry));
    box.append(text, actionRow);
    return box;
  }

  function createSegmentedControls({ video, playInfo, streamOffset, status, onSeek }) {
    const controls = document.createElement("div");
    controls.className = "android-stream-controls";

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "android-stream-button play-toggle";

    const timeLabel = document.createElement("span");
    timeLabel.className = "android-stream-time";

    const seek = document.createElement("input");
    seek.className = "android-stream-seek";
    seek.type = "range";
    seek.min = "0";
    seek.step = "1";

    const muteButton = document.createElement("button");
    muteButton.type = "button";
    muteButton.className = "android-stream-button mute-toggle";

    const fullButton = document.createElement("button");
    fullButton.type = "button";
    fullButton.className = "android-stream-button full-toggle";
    fullButton.textContent = "全屏";

    let seeking = false;

    const update = (preview = null) => {
      const duration = timelineDuration(video, playInfo, streamOffset);
      const current = preview ?? currentPlaybackPosition(video, streamOffset);
      playButton.textContent = video.paused ? "播放" : "暂停";
      muteButton.textContent = video.muted ? "开声" : "静音";
      timeLabel.textContent = duration > 0 ? `${formatTime(current)} / ${formatTime(duration)}` : formatTime(current);

      if (duration > 0) {
        seek.disabled = false;
        seek.max = String(Math.floor(duration));
        if (!seeking) seek.value = String(Math.min(Math.floor(current), Math.floor(duration)));
      } else {
        seek.disabled = true;
        seek.max = "1";
        seek.value = "0";
      }
    };

    playButton.addEventListener("click", () => {
      if (video.paused) {
        video.play().catch(() => {
          status.textContent = "请点一下画面继续播放";
        });
      } else {
        video.pause();
      }
      update();
    });

    seek.addEventListener("input", () => {
      seeking = true;
      update(Number(seek.value || 0));
    });

    seek.addEventListener("change", () => {
      const nextPosition = Number(seek.value || 0);
      const shouldPlay = !video.paused;
      seeking = false;
      onSeek(nextPosition, shouldPlay);
    });

    seek.addEventListener("pointerup", () => {
      seeking = false;
    });

    muteButton.addEventListener("click", () => {
      video.muted = !video.muted;
      update();
    });

    fullButton.addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen?.();
      } else {
        video.requestFullscreen?.();
      }
    });

    video.addEventListener("timeupdate", () => update());
    video.addEventListener("play", () => update());
    video.addEventListener("pause", () => update());
    video.addEventListener("loadedmetadata", () => update());

    controls.append(playButton, muteButton, fullButton, timeLabel, seek);
    update();
    return controls;
  }

  return {
    createVideoList,
    playDefaultVideo
  };
}







