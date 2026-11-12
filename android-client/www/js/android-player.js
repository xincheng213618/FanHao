import { fetchJson } from "./api.js?v=assets-06c1d7f13464";
import { formatBytes, formatNumber, formatTime } from "./format.js";
import { absoluteUrl } from "./image.js";
import { createDetailSectionTitle, revealDetailBlock } from "./detail-ui.js";
import { captureAccountOwner, isAccountOwnerCurrent } from "./account-owner.js";
import { openMobileActionSheet } from "./mobile-action-sheet.js?v=assets-06c1d7f13464";

const VIDEO_PICKER_PAGE_SIZE = 40;

function normalizeFileSearch(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replaceAll("\\", "/");
}

function createVideoFileRow(video, onPlay, showPath = false) {
  const row = document.createElement("div");
  row.className = "file-row";
  const info = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = video.title || video.name;
  const meta = document.createElement("span");
  const progress = video.progress?.percent ? ` · 看到 ${Math.floor(video.progress.percent)}%` : "";
  meta.textContent = [video.ext, formatBytes(video.size)].filter(Boolean).join(" · ") + progress;
  info.append(title, meta);
  if (showPath && video.relativePath && video.relativePath !== title.textContent) {
    const path = document.createElement("span");
    path.className = "work-video-picker-path";
    path.textContent = video.relativePath;
    info.append(path);
  }
  const play = document.createElement("button");
  play.type = "button";
  play.textContent = video.progress?.percent ? "继续播放" : "播放";
  play.setAttribute("aria-label", `${play.textContent} ${title.textContent}`);
  play.addEventListener("click", () => { if (row.isConnected) onPlay(); });
  row.append(info, play);
  return row;
}

export function createAndroidVideoSection(context) {
  const { getActiveUrl } = context;
  const mountScopes = new WeakMap();
  let currentPlayback = null;

  function ownsPlayback(owner, leaving = false) {
    return currentPlayback === owner && !owner.controller.signal.aborted
      && owner.mount.isConnected && (leaving || owner.isActive()) && owner.baseUrl === getActiveUrl()
      && isAccountOwnerCurrent(owner.accountScope);
  }

  function releaseRendering(owner) {
    const rendering = owner?.rendering;
    if (!rendering) return;
    rendering.report?.(true, true);
    // Retire callbacks before pause/load can synchronously deliver media events.
    owner.rendering = null;
    rendering.controller.abort();
    rendering.releaseSubtitle?.();
    if (rendering.fallbackTimer != null) window.clearTimeout(rendering.fallbackTimer);
    if (rendering.video) {
      rendering.video.pause();
      rendering.video.removeAttribute("src");
      rendering.video.load();
    }
  }

  function deactivate() {
    const owner = currentPlayback;
    if (!owner) return;
    releaseRendering(owner);
    currentPlayback = null;
    owner.controller.abort();
    owner.removeRouteListener?.();
  }

  function beginPlayback(mount, work, videoFile) {
    const scope = mountScopes.get(mount);
    if (!scope) return null;
    const { baseUrl, accountScope, isActive } = scope;
    if (!mount.isConnected || scope.workId !== work.id || baseUrl !== getActiveUrl() || !isActive()
      || isActive.signal?.aborted || !isAccountOwnerCurrent(accountScope)) return null;
    deactivate();
    const owner = { mount, baseUrl, accountScope, isActive, section: scope.section,
      workId: work.id, videoId: videoFile.id, showFiles: scope.showFiles, subtitleId: null,
      controller: new AbortController(), rendering: null };
    currentPlayback = owner;
    if (isActive.signal) {
      const leave = () => { if (currentPlayback === owner) deactivate(); };
      isActive.signal.addEventListener("abort", leave, { once: true });
      owner.removeRouteListener = () => isActive.signal.removeEventListener("abort", leave);
    }
    return owner;
  }

  window.addEventListener?.("fanhaoViewWillRender", deactivate);
  window.addEventListener?.("pagehide", deactivate);

  function createVideoList(work, options = {}) {
    if (options.preservePlayback) {
      const owner = currentPlayback;
      // Fresh metadata for this route must not discard the user's pending
      // click or replace a playing media element. Visible file lists rerender.
      if (owner && ownsPlayback(owner) && owner.showFiles === false && options.showFiles === false
        && owner.workId != null && owner.workId === work.id && owner.isActive === options.isActive
        && (work.videos || []).some(video => video.id === owner.videoId)) return owner.section;
      deactivate();
    }
    const showFiles = options.showFiles !== false;
    const showTitle = options.showTitle !== false;
    const section = document.createElement("div");
    section.className = "detail-block";
    if (showTitle) section.append(createDetailSectionTitle(options.title || "视频文件", formatNumber(work.videos?.length || 0)));

    const playerMount = document.createElement("div");
    playerMount.className = "android-player-mount";
    const baseUrl = getActiveUrl();
    mountScopes.set(playerMount, {
      baseUrl, accountScope: captureAccountOwner(baseUrl), section, workId: work.id, showFiles,
      isActive: typeof options.isActive === "function" ? options.isActive : () => true
    });
    section.append(playerMount);

    if (!showFiles) return section;

    const list = document.createElement("div");
    list.className = "file-list";
    for (const video of work.videos || []) {
      list.append(createVideoFileRow(video, () => playVideo(playerMount, work, video, { autoplay: true })));
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

  function openFilePicker(section, work, trigger) {
    let mount = null;
    let currentWork = null;
    let currentTrigger = trigger;
    const sheet = openMobileActionSheet({ title: "视频文件", trigger: () => currentTrigger });
    sheet.panel.classList.add("work-video-picker");
    const search = document.createElement("input");
    search.type = "search";
    search.className = "work-video-picker-search";
    search.placeholder = "搜索文件名或路径";
    search.autocapitalize = "off";
    search.spellcheck = false;
    search.setAttribute("aria-label", search.placeholder);
    const status = document.createElement("div");
    status.className = "work-video-picker-status";
    status.setAttribute("role", "status");
    const results = document.createElement("div");
    results.className = "work-video-picker-results";
    const list = document.createElement("div");
    list.className = "file-list";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "fanhao-sort-option work-video-picker-more";
    more.textContent = "显示更多文件";
    results.append(list, more);
    sheet.panel.append(search, status, results);

    let entries = [];
    let matches = [];
    let rendered = 0;
    let composing = false;

    function choose(video) {
      if (mount && sheet.close()) void playVideo(mount, currentWork, video, { autoplay: true });
    }

    function appendMatches(moveFocus = false) {
      const next = matches.slice(rendered, rendered + VIDEO_PICKER_PAGE_SIZE)
        .map(({ video }) => createVideoFileRow(video, () => choose(video), true));
      rendered += next.length;
      list.append(...next);
      more.hidden = rendered >= matches.length;
      if (moveFocus) next[0]?.querySelector("button")?.focus();
    }

    function renderMatches() {
      const terms = normalizeFileSearch(search.value).trim().split(/\s+/u).filter(Boolean);
      matches = entries.filter(({ text }) => terms.every(term => text.includes(term)));
      if (!entries.length) status.textContent = "这个作品没有视频文件";
      else if (!matches.length) status.textContent = "没有匹配的视频文件";
      else if (terms.length) status.textContent = `匹配 ${formatNumber(matches.length)} / ${formatNumber(entries.length)} 个文件`;
      else status.textContent = `共 ${formatNumber(entries.length)} 个文件`;
      list.replaceChildren();
      rendered = 0;
      results.scrollTop = 0;
      appendMatches();
    }

    function update(nextSection, nextWork, nextTrigger) {
      if (!sheet.overlay.isConnected) return;
      mount = nextSection.querySelector(".android-player-mount");
      currentWork = nextWork;
      currentTrigger = nextTrigger;
      entries = (nextWork.videos || []).map(video => ({
        video, text: normalizeFileSearch([video.title, video.name, video.relativePath, video.ext].join(" "))
      }));
      renderMatches();
    }

    search.addEventListener("compositionstart", () => { composing = true; });
    search.addEventListener("compositionend", () => { composing = false; renderMatches(); });
    search.addEventListener("input", event => { if (!composing && !event.isComposing) renderMatches(); });
    search.addEventListener("keydown", event => {
      if (event.key === "Enter" && !composing && !event.isComposing && matches.length === 1) {
        event.preventDefault();
        choose(matches[0].video);
      }
    });
    more.addEventListener("click", () => appendMatches(true));
    update(section, work, trigger);
    return { update };
  }

  async function playDefaultVideo(section, work) {
    const mount = section?.querySelector(".android-player-mount");
    const video = selectDefaultVideo(work);
    if (!mount || !video) return false;
    return playVideo(mount, work, video, { autoplay: true });
  }

  function selectDefaultVideo(work) {
    const videos = work.videos || [];
    return videos.find((video) => video.progress?.percent) || videos.find((video) => video.playable) || videos[0] || null;
  }

  async function playVideo(mount, work, videoFile, options = {}) {
    const owner = beginPlayback(mount, work, videoFile);
    if (!owner) return false;
    const { baseUrl: activeUrl, accountScope } = owner;
    const resume = Number(options.startAt ?? videoFile.progress?.position ?? 0);
    mount.innerHTML = `<div class="loading-row">正在准备播放</div>`;
    revealDetailBlock(mount);

    owner.subtitleTracks = readSubtitleTracks(owner);
    let playInfo = null;
    try {
      playInfo = await fetchJson(activeUrl, `/api/playinfo/${encodeURIComponent(videoFile.id)}`, {
        accountScope, signal: owner.controller.signal
      });
    } catch (error) {
      if (!ownsPlayback(owner)) return false;
      owner.cancelSubtitleLookup?.();
      mount.innerHTML = "";
      mount.append(createPlayerErrorBox(error.message || "播放地址准备失败，请重试", {
        retry: () => { if (ownsPlayback(owner)) return playVideo(mount, work, videoFile, options); }
      }));
      revealDetailBlock(mount);
      return false;
    }

    if (!ownsPlayback(owner)) return false;
    const opened = await openNativePlayer(owner, work, videoFile, playInfo, resume);
    if (!ownsPlayback(owner)) return false;
    if (opened) {
      mount.innerHTML = "";
      return true;
    }

    return renderAndroidPlayer(owner, work, videoFile, { ...options, playInfo, startAt: resume });
  }

  function readSubtitleTracks(owner) {
    if (!owner.workId || !owner.videoId) return Promise.resolve([]);
    const endpoint = `/api/works/${encodeURIComponent(owner.workId)}/subtitles`;
    const query = new URLSearchParams({ videoId: owner.videoId });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    owner.cancelSubtitleLookup = cancel;
    owner.controller.signal.addEventListener("abort", cancel, { once: true });
    const timer = window.setTimeout(cancel, 3000);
    return fetchJson(owner.baseUrl, `${endpoint}?${query}`, { accountScope: owner.accountScope, signal: controller.signal })
      .then(payload => {
        if (controller.signal.aborted || String(payload?.workId) !== String(owner.workId)
          || String(payload?.videoId) !== String(owner.videoId) || !Array.isArray(payload.tracks)) return [];
        const tracks = [];
        const ids = new Set();
        const origin = new URL(owner.baseUrl).origin;
        for (const track of payload.tracks) {
          if (!track || typeof track.id !== "string" || !track.id || track.id.length > 256 || ids.has(track.id)) continue;
          let url;
          try { url = new URL(track.url, owner.baseUrl); } catch { continue; }
          if (url.origin !== origin || url.username || url.password || url.hash
            || url.pathname !== `${endpoint}/tracks/${encodeURIComponent(track.id)}`
            || url.searchParams.get("videoId") !== String(owner.videoId)) continue;
          url.search = new URLSearchParams({ videoId: owner.videoId }).toString();
          if (url.href.length > 1024) continue;
          const language = String(track.language || "und").slice(0, 35);
          const label = String(track.label || track.id).slice(0, 200);
          const chinese = /^zh(?:[-_]|$)|^(?:chi|zho)$/i.test(language) || /中文|简体|繁体|中字|簡體|繁體/.test(label);
          tracks.push({ id: track.id, url: url.href, language, label, autoSelect: track.autoSelect === true && chinese });
          ids.add(track.id);
        }
        return tracks;
      })
      .catch(() => [])
      .finally(() => {
        window.clearTimeout(timer);
        owner.controller.signal.removeEventListener("abort", cancel);
        owner.cancelSubtitleLookup = null;
      });
  }

  async function openNativePlayer(owner, work, videoFile, playInfo, resume) {
    const plugin = nativePlayerPlugin();
    if (!plugin?.play) return false;

    try {
      const tracks = await owner.subtitleTracks;
      if (!ownsPlayback(owner)) return false;
      const subtitleTracks = tracks.slice(0, 64);
      const automaticTrack = tracks.find(track => track.autoSelect);
      if (automaticTrack && !subtitleTracks.includes(automaticTrack)) subtitleTracks[63] = automaticTrack;
      while (JSON.stringify(subtitleTracks).length > 64 * 1024) {
        const last = subtitleTracks.pop();
        if (last === automaticTrack) subtitleTracks[subtitleTracks.length - 1] = last;
      }
      const activeUrl = owner.baseUrl;
      const directUrl = absoluteUrl(activeUrl, `/media/video/${encodeURIComponent(videoFile.id)}`);
      const nativeFallbackInfo = playInfo?.mode === "direct" && playInfo.fallbackStreamUrl
        ? { ...playInfo, mode: "transcode", streamUrl: playInfo.fallbackStreamUrl }
        : playInfo;
      const fallbackUrl = nativeFallbackInfo ? streamUrlFor(activeUrl, nativeFallbackInfo, 0) : "";
      const subtitleSeekFallbackUrl = subtitleTracks.length && nativeFallbackInfo?.mode === "remux"
        ? streamUrlFor(activeUrl, transcodePlayInfo(playInfo, videoFile), 0) : "";
      const progressUrl = absoluteUrl(activeUrl, `/api/progress/${encodeURIComponent(videoFile.id)}`);
      const subtitle = [work.personDisplayName || work.personName, videoFile.ext, playInfo ? playModeText(playInfo) : "直连播放"].filter(Boolean).join(" · ");
      await plugin.play({
        url: directUrl,
        fallbackUrl,
        title: work.title || work.directoryName || videoFile.title || videoFile.name || "播放",
        subtitle,
        ...(subtitleTracks.length ? { subtitleTracks, subtitleAccountOwner: owner.accountScope.owner, subtitleSeekFallbackUrl } : {}),
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

  async function renderAndroidPlayer(owner, work, videoFile, options = {}) {
    if (!ownsPlayback(owner)) return false;
    releaseRendering(owner);
    const { mount, baseUrl: activeUrl, accountScope } = owner;
    const rendering = { controller: new AbortController(), video: null, fallbackTimer: null, report: null };
    owner.rendering = rendering;
    const ownsRender = () => ownsPlayback(owner) && owner.rendering === rendering;
    if (!options.playInfo) {
      mount.innerHTML = `<div class="loading-row">正在探测播放方式</div>`;
      revealDetailBlock(mount);
    }
    try {
      let playInfo = options.playInfo || await fetchJson(activeUrl, `/api/playinfo/${encodeURIComponent(videoFile.id)}`, {
        accountScope, signal: rendering.controller.signal
      });
      const resume = Number(options.startAt ?? videoFile.progress?.position ?? 0);
      if (playInfo.mode === "remux" && resume >= 1 && (await owner.subtitleTracks).length) {
        // Copy mode can begin at an earlier keyframe. Re-encode resumed segments
        // so the player and the shifted sidecar have the same time origin.
        playInfo = transcodePlayInfo(playInfo, videoFile);
      }
      if (!ownsRender()) return false;
      const isSegmentedStream = playInfo.mode !== "direct";
      const streamOffset = isSegmentedStream ? Math.max(0, Math.floor(resume)) : 0;
      mount.innerHTML = "";
      const playerShell = document.createElement("div");
      playerShell.className = "android-player-shell";

      const video = document.createElement("video");
      rendering.video = video;
      video.controls = !isSegmentedStream;
      video.preload = "metadata";
      video.playsInline = true;
      video.src = streamUrlFor(activeUrl, playInfo, streamOffset);
      if (playInfo.mode === "direct" && resume > 5) {
        video.addEventListener("loadedmetadata", () => {
          if (!ownsRender()) return;
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
      let lastReadyProgress = null;
      const report = (force = false, leaving = false) => {
        if (!ownsRender() && !(leaving && owner.rendering === rendering && ownsPlayback(owner, true))) return;
        const duration = timelineDuration(video, playInfo, streamOffset);
        const position = currentPlaybackPosition(video, streamOffset);
        const ready = video.readyState >= 2 && !video.error && Number.isFinite(position) && duration > 0;
        if (ready) lastReadyProgress = { position, duration };
        // A prepared URL or a failed startup is not evidence of position zero.
        // If buffering regresses readiness, exit can retain the last real sample.
        if ((!ready && !force) || !lastReadyProgress) return;
        const now = Date.now();
        if (!force && now - lastReportedAt < 5000 && !video.paused) return;
        lastReportedAt = now;
        fetchJson(activeUrl, `/api/progress/${encodeURIComponent(videoFile.id)}`, { method: "POST", accountScope, body: {
          workId: work.id,
          position: lastReadyProgress.position,
          duration: lastReadyProgress.duration
        } }).catch(() => {});
      };
      rendering.report = report;
      video.addEventListener("timeupdate", () => report());
      video.addEventListener("pause", () => report(true));
      video.addEventListener("ended", () => report(true));
      video.addEventListener("play", () => {
        if (!ownsRender()) return;
        status.textContent = "正在播放";
        actions.replaceChildren();
      });
      video.addEventListener("pause", () => {
        if (!ownsRender()) return;
        if (!video.ended) status.textContent = "已暂停";
      });
      video.addEventListener("ended", () => {
        if (!ownsRender()) return;
        status.textContent = "播放结束";
      });
      video.addEventListener("error", () => {
        if (!ownsRender()) return;
        const message = videoErrorText(video);
        if (playInfo.mode === "direct" && !options.fallbackTried) {
          status.textContent = "直连失败，正在切换智能播放";
          const fallbackInfo = fallbackPlayInfo(playInfo, videoFile);
          if (rendering.fallbackTimer != null) return;
          rendering.fallbackTimer = window.setTimeout(() => {
            rendering.fallbackTimer = null;
            if (!ownsRender()) return;
            renderAndroidPlayer(owner, work, videoFile, {
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
          createPlayerButton("重试", () => {
            if (ownsRender()) return renderAndroidPlayer(owner, work, videoFile, { autoplay: true, startAt: resume });
          }),
          ...(playInfo.mode === "remux"
            ? [createPlayerButton("强制转码", () => {
              if (ownsRender()) return renderAndroidPlayer(owner, work, videoFile, {
                autoplay: true,
                playInfo: transcodePlayInfo(playInfo, videoFile),
                startAt: currentPlaybackPosition(video, streamOffset) || resume
              });
            })]
            : [])
        );
      });

      playerShell.append(video, label, status, actions);
      attachWebSubtitles({ owner, rendering, video, playerShell, streamOffset, ownsRender });
      const requestPlay = (onRejected) => {
        if (!ownsRender()) return;
        try {
          Promise.resolve(video.play()).then(() => {
            if (!ownsRender()) video.pause();
          }, () => { if (ownsRender()) onRejected(); });
        } catch {
          if (ownsRender()) onRejected();
        }
      };
      if (isSegmentedStream) {
        playerShell.append(createSegmentedControls({
          video,
          playInfo,
          streamOffset,
          status,
          fullscreenTarget: playerShell,
          isCurrent: ownsRender,
          requestPlay,
          onSeek: (nextPosition, autoplay) => {
            if (!ownsRender()) return;
            renderAndroidPlayer(owner, work, videoFile, {
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
        requestPlay(() => {
          status.textContent = "手机系统拦截了自动播放，请点一下画面继续";
          actions.replaceChildren(
            createPlayerButton("继续播放", () => {
              requestPlay(() => {
                status.textContent = "仍无法自动播放，请直接点画面";
              });
            })
          );
        });
      }
      return true;
    } catch (error) {
      if (!ownsRender()) return false;
      releaseRendering(owner);
      const errorRendering = { controller: new AbortController(), video: null, fallbackTimer: null, report: null };
      owner.rendering = errorRendering;
      const ownsError = () => ownsPlayback(owner) && owner.rendering === errorRendering;
      mount.innerHTML = "";
      mount.append(createPlayerErrorBox(error.message, {
        retry: () => { if (ownsError()) return renderAndroidPlayer(owner, work, videoFile, { autoplay: true }); }
      }));
      revealDetailBlock(mount);
      return false;
    }
  }

  function attachWebSubtitles({ owner, rendering, video, playerShell, streamOffset, ownsRender }) {
    let request = null;
    let trackElement = null;
    let objectUrl = "";
    const clear = () => {
      request?.abort();
      request = null;
      trackElement?.remove();
      trackElement = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = "";
    };
    rendering.releaseSubtitle = clear;
    void owner.subtitleTracks.then(tracks => {
      if (!ownsRender() || !tracks.length) return;
      const row = document.createElement("div");
      row.className = "android-player-subtitles";
      const select = document.createElement("select");
      select.setAttribute("aria-label", "字幕轨道");
      const status = document.createElement("span");
      status.setAttribute("role", "status");
      const retry = createPlayerButton("重试字幕", () => void selectTrack());
      retry.hidden = true;
      const choices = [{ id: "", label: "关闭字幕" }, ...tracks];
      for (const track of choices) {
        const option = document.createElement("option");
        option.value = track.id;
        option.textContent = track.label;
        select.append(option);
      }
      select.value = owner.subtitleId ?? tracks.find(track => track.autoSelect)?.id ?? "";
      row.append(select, status, retry);
      playerShell.append(row);

      async function selectTrack() {
        if (!ownsRender()) return;
        clear();
        status.textContent = "";
        retry.hidden = true;
        const track = tracks.find(item => item.id === select.value);
        if (!track) return;
        const url = new URL(track.url);
        url.searchParams.set("offsetSeconds", String(-streamOffset));
        const controller = request = new AbortController();
        const isCurrent = () => ownsRender() && request === controller;
        status.textContent = "正在读取字幕…";
        const showError = () => {
          if (!isCurrent()) return;
          status.textContent = "字幕加载失败";
          retry.hidden = false;
        };
        try {
          const headers = { "X-FanHao-Client": "android" };
          if (owner.accountScope.owner !== "pending") headers["X-FanHao-Account-Owner"] = owner.accountScope.owner;
          const response = await fetch(url.href, {
            signal: controller.signal,
            redirect: "error",
            headers
          });
          const maxVttBytes = 8 * 1024 * 1024;
          if (!response.ok || !/^text\/vtt(?:\s*;|$)/i.test(response.headers.get("Content-Type") || "")
            || Number(response.headers.get("Content-Length")) > maxVttBytes) {
            throw new Error("Subtitle unavailable");
          }
          const data = await response.blob();
          if (!isCurrent()) return;
          if (!data.size || data.size > maxVttBytes) throw new Error("Invalid subtitle size");
          objectUrl = URL.createObjectURL(data);
          const element = trackElement = document.createElement("track");
          element.kind = "subtitles";
          element.label = track.label;
          element.srclang = track.language;
          element.src = objectUrl;
          element.addEventListener("load", () => { if (isCurrent()) status.textContent = ""; });
          element.addEventListener("error", showError);
          video.append(element);
          element.track.mode = "showing";
        } catch {
          showError();
        }
      }

      select.addEventListener("change", () => {
        if (!ownsRender()) return;
        owner.subtitleId = select.value;
        void selectTrack();
      });
      void selectTrack();
    });
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
    if (playInfo.fallbackStreamUrl) {
      return {
        ...playInfo,
        mode: "transcode",
        label: playInfo.hasNvenc ? "GPU 兼容转码" : "兼容转码",
        streamUrl: playInfo.fallbackStreamUrl,
        fallbackStreamUrl: ""
      };
    }
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

  function createSegmentedControls({ video, playInfo, streamOffset, status, fullscreenTarget, onSeek, isCurrent, requestPlay }) {
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
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      if (video.paused) {
        requestPlay(() => {
          status.textContent = "请点一下画面继续播放";
        });
      } else {
        video.pause();
      }
      update();
    });

    seek.addEventListener("input", () => {
      if (!isCurrent()) return;
      seeking = true;
      update(Number(seek.value || 0));
    });

    seek.addEventListener("change", () => {
      if (!isCurrent()) return;
      const nextPosition = Number(seek.value || 0);
      const shouldPlay = !video.paused;
      seeking = false;
      onSeek(nextPosition, shouldPlay);
    });

    seek.addEventListener("pointerup", () => {
      seeking = false;
    });

    muteButton.addEventListener("click", () => {
      if (!isCurrent()) return;
      video.muted = !video.muted;
      update();
    });

    fullButton.addEventListener("click", () => {
      if (!isCurrent()) return;
      if (document.fullscreenElement) {
        document.exitFullscreen?.();
      } else {
        const target = fullscreenTarget.requestFullscreen ? fullscreenTarget : video;
        target.requestFullscreen?.().catch(() => {});
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
    openFilePicker,
    playDefaultVideo,
    deactivate
  };
}







