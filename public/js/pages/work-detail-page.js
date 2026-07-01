export function createWorkDetailPage(deps) {
  const {
    addQueryParam,
    api,
    coverRetryDelays,
    els,
    formatBytes,
    formatLibraryPath,
    formatTime,
    goToPerson,
    openWorkCard,
    renderFavoriteFolderControls,
    renderStatsForWorks,
    renderSummary,
    renderWorks,
    retryCoverUrl,
    state,
    syncRouteAfterNavigation,
    workCoverUrl,
    workPersonDisplayName
  } = deps;

  async function openWork(workId, videoId = null, options = {}) {
    const cachedWork = state.works.find((work) => work.id === workId);
    if (cachedWork?.missingLocal) {
      openWorkCard(cachedWork);
      return;
    }

    const seq = ++state.openWorkSeq;
    reportCurrentProgress();
    stopProgressReporting();
    stopTimelineSync();
    stopPendingInfoRender();
    state.currentWork = null;
    state.currentVideo = null;
    state.currentPlayInfo = null;
    state.currentStreamOffset = 0;

    openDrawerFrame("正在加载作品", "");
    resetDrawerSideScroll();
    els.playerArea.innerHTML = `<div class="unsupported">正在读取作品</div>`;
    els.metaArea.innerHTML = "";
    els.infoArea.innerHTML = "";

    try {
      const data = await api(`/api/works/${encodeURIComponent(workId)}`);
      if (seq !== state.openWorkSeq || !els.detailDrawer.classList.contains("open")) return;

      const work = data.work;
      state.currentWork = work;
      els.drawerTitle.textContent = work.title;
      els.drawerPath.textContent = formatLibraryPath(work.relativePath);
      renderPlayer(work, videoId);
      renderMeta(work);
      scheduleInfoRender(work);
      resetDrawerSideScroll();
      syncRouteAfterNavigation({
        ...options,
        routeOverrides: { workId: work.id, videoId: videoId || state.currentVideo?.id || "" }
      });
    } catch (error) {
      if (seq !== state.openWorkSeq) return;
      els.drawerTitle.textContent = "打开失败";
      els.drawerPath.textContent = "";
      els.playerArea.innerHTML = "";
      const notice = document.createElement("div");
      notice.className = "unsupported";
      notice.textContent = error.message;
      els.playerArea.append(notice);
    }
  }

  function resetDrawerSideScroll() {
    if (!els.drawerSide) return;
    els.drawerSide.scrollTop = 0;
  }

  function openDrawerFrame(title, pathText) {
    if (!els.detailDrawer.classList.contains("open")) {
      state.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    els.drawerTitle.textContent = title;
    els.drawerPath.textContent = pathText;
    els.drawerBackdrop.hidden = false;
    els.detailDrawer.classList.add("open");
    els.detailDrawer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    window.setTimeout(() => {
      if (els.detailDrawer.classList.contains("open")) {
        els.closeDrawer.focus({ preventScroll: true });
      }
    }, 0);
  }

  function scheduleInfoRender(work) {
    stopPendingInfoRender();
    els.infoArea.innerHTML = `<div class="unsupported inline-info-loading">正在准备资料</div>`;

    const render = () => {
      state.infoRenderTimer = null;
      if (state.currentWork?.id !== work.id || !els.detailDrawer.classList.contains("open")) return;
      renderInfo(work);
    };

    if ("requestIdleCallback" in window) {
      state.infoRenderTimer = window.requestIdleCallback(render, { timeout: 700 });
    } else {
      state.infoRenderTimer = window.setTimeout(render, 120);
    }
  }

  function stopPendingInfoRender() {
    if (!state.infoRenderTimer) return;
    window.cancelIdleCallback?.(state.infoRenderTimer);
    window.clearTimeout(state.infoRenderTimer);
    state.infoRenderTimer = null;
  }

  function closeDrawer(options = {}) {
    state.openWorkSeq += 1;
    reportCurrentProgress();
    stopProgressReporting();
    stopTimelineSync();
    stopPendingInfoRender();
    els.detailDrawer.classList.remove("open");
    els.detailDrawer.setAttribute("aria-hidden", "true");
    els.drawerBackdrop.hidden = true;
    document.body.style.overflow = "";
    els.playerArea.innerHTML = "";
    state.currentWork = null;
    state.currentVideo = null;
    state.currentPlayInfo = null;
    state.currentStreamOffset = 0;

    const restoreTarget = state.lastFocusedElement;
    state.lastFocusedElement = null;
    if (restoreTarget?.isConnected) {
      window.setTimeout(() => restoreTarget.focus({ preventScroll: true }), 0);
    }
    syncRouteAfterNavigation({
      ...options,
      replaceRoute: options.replaceRoute !== false,
      routeOverrides: { workId: "", videoId: "" }
    });
  }

  function drawerFocusableElements() {
    return [
      ...els.detailDrawer.querySelectorAll(
        'a[href], button, input, select, textarea, video[controls], [tabindex]:not([tabindex="-1"])'
      )
    ].filter((element) => !element.disabled && element.getAttribute("aria-hidden") !== "true");
  }

  function trapDrawerFocus(event) {
    const focusable = drawerFocusableElements();
    if (!focusable.length) {
      event.preventDefault();
      els.detailDrawer.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function createPlayerActions(work) {
    const actions = document.createElement("div");
    actions.className = "player-actions";

    const favoriteButton = document.createElement("button");
    favoriteButton.type = "button";
    favoriteButton.className = `text-button${work.favorite ? " active" : ""}`;
    favoriteButton.textContent = work.favorite ? "★ 已收藏" : "☆ 收藏";
    favoriteButton.setAttribute("aria-label", work.favorite ? "取消收藏" : "收藏");
    favoriteButton.addEventListener("click", () => toggleFavorite(work.id));
    actions.append(favoriteButton);

    if (!workCoverUrl(work) && work.canGenerateCover) {
      const coverButton = document.createElement("button");
      coverButton.type = "button";
      coverButton.className = "text-button";
      coverButton.textContent = "生成封面";
      coverButton.setAttribute("aria-label", "生成封面");
      coverButton.addEventListener("click", () => generateWorkCover(work.id, coverButton));
      actions.append(coverButton);
    }

    return actions;
  }

  async function renderPlayer(work, requestedVideoId = null, startAt = null, autoplay = false) {
    stopProgressReporting();
    stopTimelineSync();
    els.playerArea.innerHTML = "";

    const streamableVideos = work.videos.filter(canTryWebPlay);
    if (!streamableVideos.length) {
      const unsupported = document.createElement("div");
      unsupported.className = "unsupported";
      unsupported.innerHTML = "<strong>这个作品的文件格式暂不支持网页播放。</strong><span>可以用本地播放器打开原文件。</span>";
      els.playerArea.append(unsupported);
      return;
    }

    const progressVideoId = work.progress?.videoId;
    const selected =
      streamableVideos.find((video) => video.id === requestedVideoId) ||
      streamableVideos.find((video) => video.id === progressVideoId) ||
      streamableVideos.find((video) => video.playable) ||
      streamableVideos[0];
    state.currentVideo = selected;
    state.currentPlayInfo = null;
    state.currentStreamOffset = 0;

    const loading = document.createElement("div");
    loading.className = "unsupported";
    loading.textContent = "正在探测播放方式";
    els.playerArea.append(loading);

    let playInfo;
    try {
      playInfo = await api(`/api/playinfo/${encodeURIComponent(selected.id)}`);
    } catch (error) {
      loading.textContent = error.message;
      return;
    }

    if (state.currentVideo?.id !== selected.id || state.currentWork?.id !== work.id) return;

    state.currentPlayInfo = playInfo;
    loading.remove();

    const video = document.createElement("video");
    video.className = "video-player";
    const isSegmentedStream = playInfo.mode !== "direct";
    video.controls = false;
    video.preload = state.accessHints.videoPreload || "metadata";
    video.playsInline = true;

    const savedProgress = selected.progress || (work.progress?.videoId === selected.id ? work.progress : null);
    const requestedStart = Number(startAt);
    const resumePosition = Number.isFinite(requestedStart) ? requestedStart : savedProgress?.position > 5 ? savedProgress.position : 0;
    let streamUrl = playInfo.streamUrl;
    if (isSegmentedStream && resumePosition > 0) {
      state.currentStreamOffset = resumePosition;
      streamUrl = addQueryParam(streamUrl, "t", Math.floor(resumePosition));
    }
    video.src = streamUrl;

    if (!isSegmentedStream && resumePosition > 5) {
      video.addEventListener(
        "loadedmetadata",
        () => {
          if (resumePosition < video.duration - 8) {
            video.currentTime = resumePosition;
          }
        },
        { once: true }
      );
    }

    if (autoplay) {
      video.addEventListener("canplay", () => video.play().catch(() => {}), { once: true });
    }

    video.addEventListener("pause", reportCurrentProgress);
    video.addEventListener("ended", reportCurrentProgress);
    const playerShell = document.createElement("div");
    playerShell.className = "web-player-shell";
    playerShell.append(video, createPlayerChrome(video, playInfo, work, selected, { isSegmentedStream, shell: playerShell }));
    els.playerArea.append(playerShell);
    startProgressReporting();
  }

  function currentPlaybackPosition(video = activeVideoElement()) {
    const offset = Number(state.currentStreamOffset || 0);
    const current = Number(video?.currentTime || 0);
    return Math.max(0, offset + current);
  }

  function timelineDuration(video = activeVideoElement()) {
    const candidates = [
      state.currentPlayInfo?.duration,
      state.currentVideo?.progress?.duration,
      state.currentWork?.progress?.duration
    ];
    for (const value of candidates) {
      const duration = Number(value);
      if (Number.isFinite(duration) && duration > 0) return duration;
    }

    const elementDuration = Number(video?.duration || 0);
    return Number.isFinite(elementDuration) && elementDuration > 0 ? elementDuration + state.currentStreamOffset : 0;
  }

  function createPlayerChrome(video, playInfo, work, videoFile, options = {}) {
    const shell = options.shell || els.playerArea;
    const isSegmentedStream = Boolean(options.isSegmentedStream);
    const chrome = document.createElement("div");
    chrome.className = "player-chrome";
    const abortController = new AbortController();
    state.timelineAbortController = abortController;
    const listenerOptions = { signal: abortController.signal };
    let hideTimer = null;
    let seeking = false;
    abortController.signal.addEventListener("abort", () => window.clearTimeout(hideTimer), { once: true });

    const top = document.createElement("div");
    top.className = "player-chrome-top";
    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "player-chrome-button player-chrome-back";
    backButton.textContent = "返回";
    backButton.addEventListener("click", () => closeDrawer(), listenerOptions);
    const title = document.createElement("div");
    title.className = "player-chrome-title";
    const titleText = document.createElement("strong");
    titleText.textContent = work.title || videoFile.title || videoFile.name || "播放";
    const subtitle = document.createElement("span");
    const codecText = [playInfo.videoCodec, playInfo.audioCodec].filter(Boolean).join(" / ");
    subtitle.textContent = [
      workPersonDisplayName(work),
      videoFile.ext,
      playInfo.label,
      codecText
    ].filter(Boolean).join(" · ");
    title.append(titleText, subtitle);
    const actions = createPlayerActions(work);
    actions.classList.add("player-chrome-actions");
    top.append(backButton, title, actions);

    const center = document.createElement("button");
    center.type = "button";
    center.className = "player-chrome-center";
    center.setAttribute("aria-label", "播放或暂停");

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "player-chrome-button";

    const timeLabel = document.createElement("span");
    timeLabel.className = "player-chrome-time";

    const seek = document.createElement("input");
    seek.className = "player-chrome-seek";
    seek.type = "range";
    seek.min = "0";
    seek.step = "1";
    seek.setAttribute("aria-label", "播放进度");

    const modeLabel = document.createElement("span");
    modeLabel.className = "player-chrome-mode";
    modeLabel.textContent = `${playInfo.label}${codecText ? ` · ${codecText}` : ""}`;

    const muteButton = document.createElement("button");
    muteButton.type = "button";
    muteButton.className = "player-chrome-button";

    const fullButton = document.createElement("button");
    fullButton.type = "button";
    fullButton.className = "player-chrome-button";
    fullButton.textContent = "全屏";
    fullButton.setAttribute("aria-label", "进入全屏");

    const bottom = document.createElement("div");
    bottom.className = "player-chrome-bottom";

    const update = (previewValue = null) => {
      const duration = timelineDuration(video);
      const current = previewValue ?? currentPlaybackPosition(video);
      playButton.textContent = video.paused ? "播放" : "暂停";
      playButton.setAttribute("aria-label", video.paused ? "播放" : "暂停");
      center.textContent = video.paused ? "播放" : "暂停";
      muteButton.textContent = video.muted ? "开声" : "静音";
      muteButton.setAttribute("aria-label", video.muted ? "打开声音" : "静音");
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
    const scheduleHide = () => {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => shell.classList.add("chrome-hidden"), 2500);
    };
    const showChrome = () => {
      shell.classList.remove("chrome-hidden");
      scheduleHide();
    };
    const togglePlayback = () => {
      if (video.paused) {
        video.play().catch(() => {});
      } else {
        video.pause();
      }
      update();
      showChrome();
    };

    playButton.addEventListener("click", togglePlayback, listenerOptions);
    center.addEventListener("click", togglePlayback, listenerOptions);
    video.addEventListener("click", togglePlayback, listenerOptions);
    shell.addEventListener("pointermove", showChrome, listenerOptions);
    shell.addEventListener("pointerdown", showChrome, listenerOptions);
    shell.addEventListener("keydown", showChrome, listenerOptions);

    seek.addEventListener("input", () => {
      seeking = true;
      update(Number(seek.value || 0));
      showChrome();
    }, listenerOptions);

    seek.addEventListener("change", () => {
      const nextPosition = Number(seek.value || 0);
      const shouldKeepPlaying = !video.paused;
      seeking = false;
      reportCurrentProgress({ force: true });
      if (isSegmentedStream) {
        renderPlayer(work, videoFile.id, nextPosition, shouldKeepPlaying);
        return;
      }
      const duration = timelineDuration(video);
      if (duration > 0) video.currentTime = Math.min(Math.max(nextPosition, 0), duration);
      if (shouldKeepPlaying) video.play().catch(() => {});
      update();
      showChrome();
    }, listenerOptions);

    seek.addEventListener("pointerup", () => {
      seeking = false;
      showChrome();
    }, listenerOptions);

    muteButton.addEventListener("click", () => {
      video.muted = !video.muted;
      update();
      showChrome();
    }, listenerOptions);

    fullButton.addEventListener("click", () => {
      const target = els.playerArea;
      if (document.fullscreenElement) {
        document.exitFullscreen?.();
      } else {
        target.requestFullscreen?.();
      }
      showChrome();
    }, listenerOptions);

    video.addEventListener("timeupdate", () => update(), listenerOptions);
    video.addEventListener("play", () => {
      update();
      showChrome();
    }, listenerOptions);
    video.addEventListener("pause", () => {
      update();
      showChrome();
    }, listenerOptions);
    video.addEventListener("loadedmetadata", () => update(), listenerOptions);
    video.addEventListener("canplay", () => update(), listenerOptions);
    document.addEventListener("fullscreenchange", () => {
      fullButton.textContent = document.fullscreenElement ? "退出" : "全屏";
      fullButton.setAttribute("aria-label", document.fullscreenElement ? "退出全屏" : "进入全屏");
      showChrome();
    }, listenerOptions);

    state.timelineTimer = window.setInterval(() => update(), 500);
    update();
    showChrome();

    bottom.append(playButton, timeLabel, seek, modeLabel, muteButton, fullButton);
    chrome.append(top, center, bottom);
    return chrome;
  }

  function canTryWebPlay(video) {
    return video.playable || [".mkv", ".wmv", ".avi", ".flv", ".ts"].includes(video.ext);
  }

  function renderMeta(work) {
    els.metaArea.innerHTML = "";

    if (work.personId && (work.personName || work.personDisplayName)) {
      const personJump = document.createElement("div");
      personJump.className = "person-jump";

      const text = document.createElement("div");
      text.innerHTML = `<span>人物</span><strong></strong>`;
      text.querySelector("strong").textContent = workPersonDisplayName(work);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = "查看人物";
      button.addEventListener("click", () => {
        goToPerson(work.personId);
      });

      personJump.append(text, button);
      els.metaArea.append(personJump);
    }

    const heading = document.createElement("h4");
    heading.className = "section-title";
    heading.textContent = "视频文件";

    const list = document.createElement("div");
    list.className = "file-list video-picker";

    for (const video of work.videos) {
      const item = document.createElement("div");
      item.className = `file-item${state.currentVideo?.id === video.id ? " active" : ""}`;

      const main = document.createElement("div");
      main.innerHTML = `<div class="file-name"></div><div class="file-sub"></div>`;
      main.querySelector(".file-name").textContent = video.name;
      const progress = video.progress ? ` · 看到 ${Math.floor(video.progress.percent)}%` : "";
      main.querySelector(".file-sub").textContent = `${formatLibraryPath(video.relativePath)} · ${formatBytes(video.size)}${progress}`;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button";
      button.textContent = video.playable ? "播放" : canTryWebPlay(video) ? "智能播放" : "暂不支持";
      button.disabled = !canTryWebPlay(video);
      if (canTryWebPlay(video)) {
        button.addEventListener("click", () => {
          reportCurrentProgress();
          renderPlayer(work, video.id);
          renderMeta(work);
        });
      }

      item.append(main, button);
      list.append(item);
    }

    els.metaArea.append(heading, list);
  }

  function renderInfo(work) {
    els.infoArea.innerHTML = "";
    const preview = createPreviewMediaSection(work);
    if (preview) els.infoArea.append(preview);

    if (hasStructuredInfo(work.infoMetadata)) {
      const heading = document.createElement("h4");
      heading.className = "section-title";
      heading.textContent = "作品资料";
      els.infoArea.append(heading);

      const wrapper = document.createElement("div");
      wrapper.className = "info-block inline-info-block";
      els.infoArea.append(wrapper);
      renderStructuredInfo(wrapper, work.infoMetadata);
      return;
    }

    if (!work.infos.length) {
      const empty = document.createElement("div");
      empty.className = "unsupported";
      empty.textContent = "这个作品没有资料。";
      els.infoArea.append(empty);
      return;
    }

    const heading = document.createElement("h4");
    heading.className = "section-title";
    heading.textContent = "作品资料";
    els.infoArea.append(heading);

    const wrapper = document.createElement("div");
    wrapper.className = "info-block inline-info-block";
    els.infoArea.append(wrapper);
    loadInlineInfoContent(wrapper, primaryInfoFile(work).id);
  }

  function createPreviewMediaSection(work) {
    const info = work.infoMetadata || work.infoSummary || {};
    const images = uniquePreviewImageUrls([...(info.previewImages || []), ...localPreviewImageUrls(work)]).slice(0, 12);
    const videoUrl = cleanRemoteUrl(info.previewVideoUrl);
    if (!images.length && !videoUrl) return null;

    const section = document.createElement("section");
    section.className = "preview-media-section";

    const heading = document.createElement("h4");
    heading.className = "section-title";
    heading.textContent = "预览媒体";
    section.append(heading);

    if (images.length) {
      const grid = document.createElement("div");
      grid.className = "preview-media-grid";
      for (const imageUrl of images) {
        const link = document.createElement("a");
        link.className = "preview-media-thumb";
        link.href = imageUrl;
        link.target = "_blank";
        link.rel = "noreferrer";
        const img = document.createElement("img");
        img.loading = "lazy";
        img.decoding = "async";
        img.alt = "";
        img.addEventListener("load", () => {
          img.dataset.loaded = "1";
        });
        img.addEventListener("error", () => {
          retryPreviewImage(img, imageUrl);
        });
        img.src = imageUrl;
        link.append(img);
        grid.append(link);
      }
      section.append(grid);
    }

    if (videoUrl) {
      const actions = document.createElement("div");
      actions.className = "preview-media-actions";
      const link = document.createElement("a");
      link.className = "text-button preview-media-link";
      link.href = videoUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "打开预览视频";
      actions.append(link);
      section.append(actions);
    }

    return section;
  }

  function retryPreviewImage(img, src) {
    if (!img?.isConnected || img.dataset.loaded === "1") return;
    const retryCount = Number(img.dataset.retryCount || 0);
    if (retryCount >= coverRetryDelays.length) return;
    const delay = coverRetryDelays[Math.min(retryCount, coverRetryDelays.length - 1)];
    img.dataset.retryCount = String(retryCount + 1);
    window.setTimeout(() => {
      if (!img.isConnected || img.dataset.loaded === "1") return;
      img.src = retryCoverUrl(src, retryCount + 1);
    }, delay);
  }

  function localPreviewImageUrls(work) {
    return [...(work.images || [])]
      .filter((image) => image?.id && image.id !== work.coverId)
      .sort(comparePreviewImageFiles)
      .map((image) => `/media/image/${encodeURIComponent(image.id)}`);
  }

  function comparePreviewImageFiles(a, b) {
    return previewImageRank(a) - previewImageRank(b) || String(a.relativePath || a.name || "").localeCompare(String(b.relativePath || b.name || ""));
  }

  function previewImageRank(image) {
    const text = `${image?.relativePath || ""} ${image?.name || ""}`.toLowerCase();
    if (/(?:extra[-_ ]?fanart|sample|screenshot|preview|fanart)/.test(text)) return 0;
    if (/(?:poster|cover|folder|front|thumb|thumbnail)/.test(text)) return 2;
    return 1;
  }

  function cleanRemoteUrl(value) {
    const text = String(value || "").trim();
    if (!/^https?:\/\//i.test(text)) return "";
    return text;
  }

  function cleanPreviewImageUrl(value) {
    const text = String(value || "").trim();
    if (/^https?:\/\//i.test(text) || /^\/media\/(?:image|remote-image)\b/i.test(text)) return text;
    return "";
  }

  function uniquePreviewImageUrls(values) {
    const seen = new Set();
    const urls = [];
    for (const value of Array.isArray(values) ? values : []) {
      const url = cleanPreviewImageUrl(value);
      const key = url.toLowerCase();
      if (!url || seen.has(key)) continue;
      seen.add(key);
      urls.push(url);
    }
    return urls;
  }

  function primaryInfoFile(work) {
    const infos = work.infos || [];
    return infos.find((info) => /^info\.(txt|json|nfo)$/i.test(info.name || "")) || infos[0];
  }

  async function loadInlineInfoContent(wrapper, infoId) {
    wrapper.innerHTML = `<div class="unsupported inline-info-loading">正在读取资料</div>`;
    try {
      const data = await api(`/api/info/${encodeURIComponent(infoId)}`);
      if (data.displayable === false) {
        const notice = document.createElement("div");
        notice.className = "unsupported";
        notice.textContent = "这个作品没有可显示的作品资料。";
        wrapper.replaceChildren(notice);
        return;
      }

      if (hasStructuredInfo(data.metadata)) {
        renderStructuredInfo(wrapper, data.metadata);
        return;
      }

      const pre = document.createElement("pre");
      pre.className = "info-content inline-info-content";
      pre.textContent = data.content || "这个作品没有可显示内容。";
      wrapper.replaceChildren(pre);
    } catch (error) {
      const notice = document.createElement("div");
      notice.className = "unsupported info-error";
      notice.textContent = error.message;
      wrapper.replaceChildren(notice);
    }
  }

  function hasStructuredInfo(metadata) {
    return Boolean(metadata && ((metadata.fields || []).length || metadata.rawText));
  }

  function renderStructuredInfo(mount, metadata) {
    mount.innerHTML = "";
    const panel = document.createElement("div");
    panel.className = "structured-info-panel";

    const fields = metadata.fields || [];
    if (fields.length) {
      const grid = document.createElement("dl");
      grid.className = "structured-info-grid";
      for (const field of fields) {
        const label = document.createElement("dt");
        label.textContent = field.label;
        const value = document.createElement("dd");
        value.textContent = field.value;
        grid.append(label, value);
      }
      panel.append(grid);
    } else {
      const pre = document.createElement("pre");
      pre.className = "info-content inline-info-content";
      pre.textContent = metadata.rawText || "这个作品没有可显示内容。";
      panel.append(pre);
    }

    if (metadata.rawTextTruncated) {
      const note = document.createElement("div");
      note.className = "info-preview-note";
      note.textContent = "资料较长，已显示主要字段。";
      panel.append(note);
    }

    mount.append(panel);
  }

  async function generateWorkCover(workId, button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "生成中";
    try {
      const data = await api(`/api/works/${encodeURIComponent(workId)}/cover/generate`, { method: "POST" });
      if (data.work) {
        updateWorkSnapshot(data.work);
        state.currentWork = data.work;
        renderPlayer(state.currentWork, state.currentVideo?.id);
        renderMeta(state.currentWork);
        renderWorks();
      }
    } catch (error) {
      alert(error.message);
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  async function toggleFavorite(workId) {
    const data = await api(`/api/favorites/${encodeURIComponent(workId)}`, { method: "POST" });
    state.favoriteFolders = data.folders || state.favoriteFolders;
    updateWorkFavorite(workId, data.favorite, data.favoriteFolder);
    state.library.user = data.user;
    renderSummary();

    if (state.currentWork?.id === workId) {
      state.currentWork.favorite = data.favorite;
      if (data.favoriteFolder) {
        state.currentWork.favoriteFolderId = data.favoriteFolder.folderId;
        state.currentWork.favoriteFolderName = data.favoriteFolder.folderName;
      } else {
        state.currentWork.favoriteFolderId = "";
        state.currentWork.favoriteFolderName = "";
      }
      renderPlayer(state.currentWork, state.currentVideo?.id);
    }

    if (state.activeView === "favorites" && !data.favorite) {
      state.works = state.works.filter((work) => work.id !== workId);
    }

    if (state.activeView === "favorites") {
      renderStatsForWorks(state.works);
      renderFavoriteFolderControls();
    }
    renderWorks(state.activeView === "favorites" ? "还没有收藏。" : "没有匹配的作品。");
  }

  async function moveFavoriteToFolder(work, folderId, control) {
    const previous = work.favoriteFolderId || "default";
    control.disabled = true;
    try {
      const data = await api(`/api/favorites/${encodeURIComponent(work.id)}/folder`, { method: "PUT", body: { folderId } });
      state.favoriteFolders = data.folders || state.favoriteFolders;
      updateWorkFavoriteFolder(work.id, data.favorite);
      state.library.user = data.user;
      renderSummary();

      if (state.currentWork?.id === work.id) {
        state.currentWork.favoriteFolderId = data.favorite.folderId;
        state.currentWork.favoriteFolderName = data.favorite.folderName;
      }

      if (state.activeView === "favorites" && state.selectedFavoriteFolderId !== "all" && data.favorite.folderId !== state.selectedFavoriteFolderId) {
        state.works = state.works.filter((item) => item.id !== work.id);
      }
      renderStatsForWorks(state.works);
      renderFavoriteFolderControls();
      renderWorks("还没有收藏。");
    } catch (error) {
      control.value = previous;
      alert(error.message);
    } finally {
      control.disabled = false;
    }
  }

  function updateWorkFavorite(workId, favorite, favoriteFolder = null) {
    for (const work of state.works) {
      if (work.id !== workId) continue;
      work.favorite = favorite;
      if (favorite && favoriteFolder) {
        work.favoriteFolderId = favoriteFolder.folderId;
        work.favoriteFolderName = favoriteFolder.folderName;
      }
      if (!favorite) {
        work.favoriteFolderId = "";
        work.favoriteFolderName = "";
      }
    }
  }

  function updateWorkFavoriteFolder(workId, favoriteFolder) {
    for (const work of state.works) {
      if (work.id !== workId) continue;
      work.favoriteFolderId = favoriteFolder.folderId;
      work.favoriteFolderName = favoriteFolder.folderName;
    }
  }

  function updateWorkSnapshot(nextWork) {
    const index = state.works.findIndex((work) => work.id === nextWork.id);
    if (index >= 0) state.works[index] = { ...state.works[index], ...nextWork };
  }

  function startProgressReporting() {
    stopProgressReporting();
    state.progressTimer = window.setInterval(reportCurrentProgress, 5000);
  }

  function stopProgressReporting() {
    if (state.progressTimer) {
      window.clearInterval(state.progressTimer);
      state.progressTimer = null;
    }
  }

  function stopTimelineSync() {
    if (state.timelineTimer) {
      window.clearInterval(state.timelineTimer);
      state.timelineTimer = null;
    }
    if (state.timelineAbortController) {
      state.timelineAbortController.abort();
      state.timelineAbortController = null;
    }
  }

  function activeVideoElement() {
    return els.playerArea.querySelector("video");
  }

  function reportCurrentProgress(options = {}) {
    const video = activeVideoElement();
    const duration = timelineDuration(video);
    if (!state.currentVideo || !state.currentWork || !video || !Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const now = Date.now();
    if (!options.force && now - state.lastProgressReport < 1400) return;
    state.lastProgressReport = now;

    api(`/api/progress/${encodeURIComponent(state.currentVideo.id)}`, {
      method: "POST",
      body: {
        workId: state.currentWork.id,
        position: currentPlaybackPosition(video),
        duration
      }
    })
      .then((data) => {
        state.currentVideo.progress = data.progress;
        state.currentWork.progress = data.progress;
        state.library.user = data.user;
        renderSummary();
      })
      .catch(() => {});
  }

  return {
    closeDrawer,
    moveFavoriteToFolder,
    openWork,
    renderMeta,
    renderPlayer,
    reportCurrentProgress,
    toggleFavorite,
    trapDrawerFocus,
    updateWorkSnapshot
  };
}
