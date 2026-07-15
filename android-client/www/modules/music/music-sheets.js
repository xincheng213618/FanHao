import { formatBytes, formatNumber } from "../../js/format.js";
import {
  CROSSFADE_SECONDS_OPTIONS,
  FADE_SECONDS_OPTIONS,
  PLAYBACK_SPEED_OPTIONS,
  SLEEP_AFTER_CURRENT,
  SLEEP_TIMER_OPTIONS,
  VERSION_STRATEGY_OPTIONS,
  clearPlaybackQueuePreference,
  normalizeVersionStrategy,
  playbackSpeedLabel,
  sleepOptionLabel,
  versionStrategyDescription,
  versionStrategyLabel,
  writeRememberVersionChoicesPreference,
  writeRepeatPreference,
  writeResumeQueuePreference,
  writeShufflePreference,
  writeVersionPreferencesPreference,
  writeVersionStrategyPreference
} from "./music-state.js?v=20260716-music-state-01";

export function createMusicSheets(deps) {
  const {
    activateSearchResultQueue,
    addTrackToPlaylist,
    appendTrackToQueue,
    attachSheetDismissSwipe,
    closeSettings,
    createPlaylistFromPrompt,
    downloadTrack,
    els,
    getActiveUrl,
    iconButton,
    openTrack,
    queueTrackNext,
    rememberPlaybackQueue,
    removeTrackFromCurrentPlaylist,
    renderCover,
    renderSheetHandle,
    renderShell,
    scheduleGaplessPreload,
    setCrossfadeSeconds,
    setFadeSeconds,
    setGaplessPlayback,
    setPlaybackSpeed,
    setPlaybackTransitionMode,
    setSleepTimer,
    setVolume,
    sleepTimerActive,
    sleepTimerText,
    state,
    toggleFavorite,
    trackMeta,
    updateListParams
  } = deps;

  function renderSleepTimerSheet() {
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-queue-sheet music-mobile-sleep-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "定时关闭");

    const head = document.createElement("div");
    head.className = "music-mobile-queue-head";
    const title = document.createElement("strong");
    title.textContent = "定时关闭";
    const meta = document.createElement("small");
    meta.textContent = sleepTimerActive() ? sleepTimerText() : "未开启";
    const close = iconButton("×", () => {
      state.sleepSheetOpen = false;
      renderShell();
    }, false, "ghost", "关闭定时选择");
    head.append(title, meta, close);
    attachSheetDismissSwipe(head);

    const list = document.createElement("div");
    list.className = "music-mobile-queue-list music-mobile-sleep-list";
    for (const minutes of SLEEP_TIMER_OPTIONS) {
      const row = document.createElement("button");
      row.type = "button";
      row.disabled = minutes === SLEEP_AFTER_CURRENT && !state.current;
      row.className = `music-mobile-sleep-choice${sleepTimerActive() && state.sleepMinutes === minutes ? " active" : ""}`;
      row.addEventListener("click", () => {
        state.sleepSheetOpen = false;
        setSleepTimer(minutes);
      });
      const label = document.createElement("strong");
      label.textContent = sleepOptionLabel(minutes);
      const metaText = document.createElement("small");
      metaText.textContent = minutes === SLEEP_AFTER_CURRENT
        ? !state.current
          ? "需要先播放一首歌"
          : state.sleepMinutes === minutes
            ? "当前歌曲结束后暂停"
            : "不再自动播放下一首"
        : sleepTimerActive() && state.sleepMinutes === minutes
          ? `剩余 ${sleepTimerText()}`
          : "到点暂停";
      row.append(label, metaText);
      list.append(row);
    }

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "music-mobile-sleep-choice danger";
    clear.disabled = !sleepTimerActive();
    clear.addEventListener("click", () => {
      state.sleepSheetOpen = false;
      setSleepTimer(0);
    });
    const clearLabel = document.createElement("strong");
    clearLabel.textContent = "关闭定时";
    const clearMeta = document.createElement("small");
    clearMeta.textContent = sleepTimerActive() ? "取消睡眠定时" : "未开启";
    clear.append(clearLabel, clearMeta);
    list.append(clear);

    sheet.append(renderSheetHandle(), head, list);
    return sheet;
  }

  function openTrackActions(trackId) {
    const id = String(trackId || "").trim();
    if (!id || !trackForActions(id)) return;
    els.viewContent?.querySelector(".music-mobile-search-input")?.blur();
    state.trackActionId = id;
    state.settingsOpen = false;
    renderShell();
  }

  function closeTrackActions() {
    if (!state.trackActionId) return false;
    state.trackActionId = "";
    renderShell();
    return true;
  }

  function trackForActions(trackId = state.trackActionId) {
    const id = String(trackId || "").trim();
    if (!id) return null;
    return [state.current, ...(state.data?.tracks || []), ...(state.queue || [])]
      .find((track) => track?.id === id) || null;
  }

  function renderTrackActionsBackdrop() {
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-mobile-settings-backdrop music-mobile-track-actions-backdrop";
    backdrop.setAttribute("aria-label", "关闭歌曲操作");
    backdrop.addEventListener("click", closeTrackActions);
    return backdrop;
  }

  function renderTrackActionsSheet() {
    const track = trackForActions();
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-settings-sheet music-mobile-track-actions-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", `歌曲操作：${track?.title || "歌曲"}`);

    const head = document.createElement("div");
    head.className = "music-mobile-track-actions-head";
    head.append(renderCover(track || { title: "音乐" }, "tiny"));
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = track?.title || "未知歌曲";
    const meta = document.createElement("small");
    meta.textContent = track ? trackMeta(track) : "歌曲不可用";
    text.append(title, meta);
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "完成";
    close.addEventListener("click", closeTrackActions);
    head.append(text, close);

    const actions = document.createElement("div");
    actions.className = "music-mobile-track-actions-grid";
    if (track) {
      actions.append(trackActionChoice("立即播放", "用这首歌替换当前播放位置。", () => {
        state.trackActionId = "";
        activateSearchResultQueue(track.id);
        openTrack(track.id, { autoplay: true }).catch(() => {});
      }));
      actions.append(trackActionChoice("下一首播放", "插入到当前歌曲后面。", () => {
        state.trackActionId = "";
        queueTrackNext(track);
      }));
      actions.append(trackActionChoice("加入队列", "保留当前顺序并放到队尾。", () => {
        state.trackActionId = "";
        appendTrackToQueue(track);
      }));
      actions.append(trackActionChoice("加入歌单", "保存到已有歌单或新建歌单。", () => {
        state.trackActionId = "";
        state.playlistActionTrackId = track.id;
        renderShell();
      }));
      actions.append(trackActionChoice(track.favorite ? "取消收藏" : "收藏歌曲", track.favorite ? "从收藏列表移除。" : "以后可以从收藏快速找到。", () => {
        state.trackActionId = "";
        toggleFavorite(track.id).catch(() => {});
      }, { active: track.favorite }));
      if (track.artistId) actions.append(trackActionChoice("查看歌手", track.artist || "打开歌手页面。", () => {
        state.trackActionId = "";
        updateListParams({ mode: "library", artistId: track.artistId, albumId: "", genre: "", query: "" }, { resetSearch: true });
      }));
      if (track.albumId) actions.append(trackActionChoice("查看专辑", track.album || "打开专辑页面。", () => {
        state.trackActionId = "";
        updateListParams({ mode: "library", albumId: track.albumId, artistId: track.artistId || "", genre: "", query: "" }, { resetSearch: true });
      }));
      if (track.downloadUrl) actions.append(trackActionChoice("保存原文件", formatBytes(track.sizeBytes || 0), () => {
        state.trackActionId = "";
        downloadTrack(track);
        renderShell();
      }));
      if (state.mode === "playlist" && state.playlistId) actions.append(trackActionChoice("移出当前歌单", "不会删除本地音乐文件。", () => {
        state.trackActionId = "";
        removeTrackFromCurrentPlaylist(track.id).catch(() => {});
      }, { danger: true }));
    }
    sheet.append(renderSheetHandle(), head, actions);
    return sheet;
  }

  function trackActionChoice(label, description, action, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `music-mobile-track-action-choice${options.active ? " active" : ""}${options.danger ? " danger" : ""}`;
    const title = document.createElement("strong");
    title.textContent = label;
    const meta = document.createElement("small");
    meta.textContent = description;
    button.append(title, meta);
    button.addEventListener("click", action);
    return button;
  }

  function closePlaylistActions() {
    if (!state.playlistActionTrackId) return false;
    state.playlistActionTrackId = "";
    renderShell();
    return true;
  }

  function renderPlaylistActionsBackdrop() {
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-mobile-settings-backdrop music-mobile-track-actions-backdrop";
    backdrop.setAttribute("aria-label", "关闭加入歌单");
    backdrop.addEventListener("click", closePlaylistActions);
    return backdrop;
  }

  function renderPlaylistActionsSheet() {
    const track = trackForActions(state.playlistActionTrackId);
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-settings-sheet music-mobile-playlist-actions-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", `加入歌单：${track?.title || "歌曲"}`);

    const head = document.createElement("div");
    head.className = "music-mobile-track-actions-head";
    head.append(renderCover(track || { title: "音乐" }, "tiny"));
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = "加入歌单";
    const meta = document.createElement("small");
    meta.textContent = track?.title || "选择保存位置";
    text.append(title, meta);
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "完成";
    close.addEventListener("click", closePlaylistActions);
    head.append(text, close);

    const list = document.createElement("div");
    list.className = "music-mobile-playlist-action-list";
    const create = document.createElement("button");
    create.type = "button";
    create.className = "music-mobile-playlist-action-choice create";
    const createTitle = document.createElement("strong");
    createTitle.textContent = "新建歌单";
    const createMeta = document.createElement("small");
    createMeta.textContent = "创建后立即加入这首歌";
    create.append(createTitle, createMeta);
    create.addEventListener("click", () => createPlaylistFromPrompt({ addTrackId: track?.id }).catch(() => {}));
    list.append(create);
    for (const playlist of state.playlists || []) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = "music-mobile-playlist-action-choice";
      const name = document.createElement("strong");
      name.textContent = playlist.name || "未命名歌单";
      const count = document.createElement("small");
      count.textContent = `${formatNumber(playlist.trackCount || 0)} 首`;
      choice.append(name, count);
      choice.addEventListener("click", () => addTrackToPlaylist(playlist.id, track?.id).catch(() => {}));
      list.append(choice);
    }
    sheet.append(renderSheetHandle(), head, list);
    return sheet;
  }

  function renderSettingsBackdrop() {
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-mobile-settings-backdrop";
    backdrop.setAttribute("aria-label", "关闭音乐设置");
    backdrop.addEventListener("click", closeSettings);
    return backdrop;
  }

  function renderSettingsSheet() {
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-settings-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "音乐设置");

    const head = document.createElement("div");
    head.className = "music-mobile-settings-head";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = "播放设置";
    const meta = document.createElement("small");
    meta.textContent = "衔接、声音、搜索与播放现场";
    text.append(title, meta);
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "完成";
    close.addEventListener("click", closeSettings);
    head.append(text, close);

    const summary = renderSettingsTransitionSummary();

    const transition = document.createElement("section");
    transition.className = "music-mobile-settings-group";
    transition.append(settingsGroupTitle("歌曲衔接"), renderSettingsTransitionPresets());
    const gapless = document.createElement("button");
    gapless.type = "button";
    gapless.className = `music-mobile-settings-switch${state.gapless ? " active" : ""}`;
    gapless.setAttribute("role", "switch");
    gapless.setAttribute("aria-checked", state.gapless ? "true" : "false");
    gapless.textContent = state.gapless ? (state.shuffle ? "随机时暂停" : "已开启") : "已关闭";
    gapless.addEventListener("click", () => setGaplessPlayback(!state.gapless));
    transition.append(settingsRow(
      "无缝播放",
      "由预载播放器直接接管下一首，自动切歌时减少停顿；随机播放时暂停预载，少数格式可能不生效。",
      gapless
    ));

    const crossfade = document.createElement("select");
    crossfade.setAttribute("aria-label", "歌曲交叉淡化时长");
    for (const seconds of CROSSFADE_SECONDS_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(seconds);
      option.textContent = seconds ? `${seconds} 秒` : "关闭";
      crossfade.append(option);
    }
    crossfade.value = String(state.crossfadeSeconds);
    crossfade.addEventListener("change", () => setCrossfadeSeconds(Number(crossfade.value || 0)));
    transition.append(settingsRow(
      "歌曲交叉淡化",
      state.shuffle
        ? "随机播放时暂停预载；关闭随机播放后自动恢复。"
        : "在上一首结束前启动下一首并平滑交接；开启后会自动关闭无缝播放。",
      crossfade
    ));

    const fade = document.createElement("select");
    fade.setAttribute("aria-label", "淡入淡出时长");
    for (const seconds of FADE_SECONDS_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(seconds);
      option.textContent = seconds ? `${seconds} 秒` : "关闭";
      fade.append(option);
    }
    fade.value = String(state.fadeSeconds);
    fade.addEventListener("change", () => setFadeSeconds(Number(fade.value || 0)));
    transition.append(settingsRow(
      "播放 / 暂停淡化",
      "播放和暂停时平滑调整音量，避免声音突然出现或消失。",
      fade
    ));

    const playback = document.createElement("section");
    playback.className = "music-mobile-settings-group";
    playback.append(settingsGroupTitle("播放偏好"));
    playback.append(settingsRow("播放音量", "只调整应用内音乐音量，系统媒体音量不变。", renderSettingsVolumeControl()));
    const speed = document.createElement("select");
    speed.setAttribute("aria-label", "默认播放速度");
    for (const value of PLAYBACK_SPEED_OPTIONS) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = playbackSpeedLabel(value);
      speed.append(option);
    }
    speed.value = String(state.playbackSpeed);
    speed.addEventListener("change", () => setPlaybackSpeed(Number(speed.value || 1)));
    playback.append(settingsRow("播放速度", "新打开的歌曲沿用此速度。", speed));

    const repeat = document.createElement("select");
    repeat.setAttribute("aria-label", "默认循环方式");
    for (const [value, label] of [["all", "列表循环"], ["one", "单曲循环"], ["none", "顺序播放"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      repeat.append(option);
    }
    repeat.value = state.repeat;
    repeat.addEventListener("change", () => {
      state.repeat = repeat.value;
      writeRepeatPreference(state.repeat);
      scheduleGaplessPreload();
    });
    playback.append(settingsRow("循环方式", "自动切歌时使用的默认队列策略。", repeat));

    const shuffle = document.createElement("button");
    shuffle.type = "button";
    shuffle.className = `music-mobile-settings-switch${state.shuffle ? " active" : ""}`;
    shuffle.setAttribute("role", "switch");
    shuffle.setAttribute("aria-checked", state.shuffle ? "true" : "false");
    shuffle.textContent = state.shuffle ? "已开启" : "已关闭";
    shuffle.addEventListener("click", () => {
      state.shuffle = !state.shuffle;
      writeShufflePreference(state.shuffle);
      scheduleGaplessPreload();
      renderShell();
    });
    playback.append(settingsRow("随机播放", "从队列随机选择下一首；开启后会暂停无缝预载。", shuffle));

    const resumeQueue = document.createElement("button");
    resumeQueue.type = "button";
    resumeQueue.className = `music-mobile-settings-switch${state.resumeQueue ? " active" : ""}`;
    resumeQueue.setAttribute("role", "switch");
    resumeQueue.setAttribute("aria-checked", state.resumeQueue ? "true" : "false");
    resumeQueue.textContent = state.resumeQueue ? "已开启" : "已关闭";
    resumeQueue.addEventListener("click", () => {
      state.resumeQueue = !state.resumeQueue;
      writeResumeQueuePreference(state.resumeQueue);
      if (state.resumeQueue) rememberPlaybackQueue();
      else clearPlaybackQueuePreference();
      renderShell();
    });
    playback.append(settingsRow("恢复播放现场", "下次打开时恢复当前歌曲、播放位置和整理过的队列。", resumeQueue));

    const sleepTimer = document.createElement("button");
    sleepTimer.type = "button";
    sleepTimer.className = "music-mobile-settings-action";
    sleepTimer.textContent = sleepTimerActive() ? sleepTimerText() : "设置";
    sleepTimer.addEventListener("click", () => {
      state.settingsOpen = false;
      state.fullscreen = true;
      state.sleepSheetOpen = true;
      state.queueOpen = false;
      state.playlistSheetOpen = false;
      renderShell();
    });
    playback.append(settingsRow(
      "睡眠定时",
      "可以按时间暂停，也可以让当前歌曲完整播完后停止，不再自动切到下一首。",
      sleepTimer
    ));

    const searchVersions = document.createElement("section");
    searchVersions.className = "music-mobile-settings-group";
    searchVersions.append(settingsGroupTitle("搜索与版本"));

    const versionStrategy = document.createElement("select");
    versionStrategy.setAttribute("aria-label", "默认播放版本策略");
    for (const [value, label] of VERSION_STRATEGY_OPTIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      versionStrategy.append(option);
    }
    versionStrategy.value = state.versionStrategy;
    versionStrategy.addEventListener("change", () => setVersionStrategy(versionStrategy.value));
    searchVersions.append(settingsRow(
      "默认播放版本",
      versionStrategyDescription(state.versionStrategy),
      versionStrategy
    ));

    const rememberVersions = document.createElement("button");
    rememberVersions.type = "button";
    rememberVersions.className = `music-mobile-settings-switch${state.rememberVersionChoices ? " active" : ""}`;
    rememberVersions.setAttribute("role", "switch");
    rememberVersions.setAttribute("aria-checked", state.rememberVersionChoices ? "true" : "false");
    rememberVersions.textContent = state.rememberVersionChoices ? "已开启" : "已关闭";
    rememberVersions.addEventListener("click", () => setRememberVersionChoices(!state.rememberVersionChoices));
    searchVersions.append(settingsRow(
      "记住版本选择",
      "同一首歌有原版、Live 或 Remix 时，下次搜索会默认播放你上次选择的版本。",
      rememberVersions
    ));

    const preferenceCount = activeVersionPreferenceCount();
    const clearVersions = document.createElement("button");
    clearVersions.type = "button";
    clearVersions.className = "music-mobile-settings-action";
    clearVersions.textContent = preferenceCount ? `清除 ${formatNumber(preferenceCount)} 首` : "暂无记录";
    clearVersions.disabled = preferenceCount < 1;
    clearVersions.addEventListener("click", clearActiveVersionPreferences);
    searchVersions.append(settingsRow(
      "版本偏好",
      preferenceCount ? `当前音乐服务已记住 ${formatNumber(preferenceCount)} 首歌，可随时恢复为全局策略。` : "选择具体版本后会显示在这里。",
      clearVersions
    ));

    const note = document.createElement("p");
    note.className = "music-mobile-settings-note";
    note.textContent = "这些设置只保存在当前手机，不会修改电脑端音乐文件。";
    sheet.append(renderSheetHandle(), head, summary, transition, playback, searchVersions, note);
    return sheet;
  }

  function setRememberVersionChoices(enabled) {
    state.rememberVersionChoices = Boolean(enabled);
    writeRememberVersionChoicesPreference(state.rememberVersionChoices);
    state.status = state.rememberVersionChoices ? "已开启版本选择记忆" : "已暂停版本选择记忆";
    renderShell();
  }

  function setVersionStrategy(value) {
    state.versionStrategy = normalizeVersionStrategy(value);
    writeVersionStrategyPreference(state.versionStrategy);
    state.status = `默认播放版本已设为${versionStrategyLabel(state.versionStrategy)}`;
    const select = els.viewContent?.querySelector('select[aria-label="默认播放版本策略"]');
    const description = select?.closest(".music-mobile-settings-row")?.querySelector("small");
    if (description) description.textContent = versionStrategyDescription(state.versionStrategy);
  }

  function activeVersionPreferenceCount() {
    const prefix = `${String(getActiveUrl() || "").replace(/\/+$/u, "")}|`;
    return Object.keys(state.versionPreferences || {}).filter((key) => prefix !== "|" && key.startsWith(prefix)).length;
  }

  function clearActiveVersionPreferences() {
    const prefix = `${String(getActiveUrl() || "").replace(/\/+$/u, "")}|`;
    if (prefix === "|") return;
    const next = Object.fromEntries(Object.entries(state.versionPreferences || {}).filter(([key]) => !key.startsWith(prefix)));
    state.versionPreferences = next;
    writeVersionPreferencesPreference(next);
    state.status = "已清除当前音乐服务的版本偏好";
    renderShell();
  }

  function renderSettingsTransitionSummary() {
    const summary = document.createElement("section");
    summary.className = "music-mobile-settings-summary";
    const eyebrow = document.createElement("small");
    eyebrow.textContent = "当前衔接方式";
    const title = document.createElement("strong");
    title.textContent = state.shuffle
      ? "随机播放 · 衔接预载暂停"
      : state.crossfadeSeconds > 0
        ? `歌曲交叉淡化 · ${state.crossfadeSeconds} 秒`
        : state.gapless
          ? "无缝播放"
          : "标准切歌";
    const meta = document.createElement("span");
    meta.textContent = state.shuffle
      ? "关闭随机播放后，会继续使用你保存的衔接方式。"
      : state.crossfadeSeconds > 0
        ? "两首歌会短暂重叠，切换更柔和。"
        : state.gapless
          ? "提前准备下一首，优先减少歌曲间停顿。"
          : "每首歌独立结束后再开始下一首。";
    summary.append(eyebrow, title, meta);
    return summary;
  }

  function renderSettingsTransitionPresets() {
    const wrap = document.createElement("div");
    wrap.className = "music-mobile-settings-transition-presets";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "歌曲衔接模式");
    const activeMode = currentPlaybackTransitionMode();
    for (const item of [
      { mode: "standard", label: "标准", meta: "独立切歌" },
      { mode: "gapless", label: "无缝", meta: "提前预载" },
      { mode: "smooth", label: "柔和", meta: "重叠淡化" }
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = item.mode === activeMode ? "active" : "";
      button.dataset.transitionMode = item.mode;
      button.setAttribute("aria-pressed", item.mode === activeMode ? "true" : "false");
      const label = document.createElement("strong");
      label.textContent = item.label;
      const meta = document.createElement("small");
      meta.textContent = item.meta;
      button.append(label, meta);
      button.addEventListener("click", () => setPlaybackTransitionMode(item.mode));
      wrap.append(button);
    }
    return wrap;
  }

  function currentPlaybackTransitionMode() {
    if (state.crossfadeSeconds > 0) return "smooth";
    return state.gapless ? "gapless" : "standard";
  }

  function settingsGroupTitle(label) {
    const title = document.createElement("strong");
    title.className = "music-mobile-settings-group-title";
    title.textContent = label;
    return title;
  }

  function renderSettingsVolumeControl() {
    const control = document.createElement("label");
    control.className = "music-mobile-settings-volume";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(state.volume * 100));
    slider.setAttribute("aria-label", "播放音量");
    const value = document.createElement("span");
    value.textContent = `${slider.value}%`;
    slider.addEventListener("input", () => {
      value.textContent = `${slider.value}%`;
      setVolume(Number(slider.value || 0) / 100);
    });
    control.append(slider, value);
    return control;
  }

  function settingsRow(label, description, control) {
    const row = document.createElement("div");
    row.className = "music-mobile-settings-row";
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = label;
    const meta = document.createElement("small");
    meta.textContent = description;
    text.append(title, meta);
    row.append(text, control);
    return row;
  }


  return {
    closePlaylistActions,
    closeTrackActions,
    openTrackActions,
    renderPlaylistActionsBackdrop,
    renderPlaylistActionsSheet,
    renderSettingsBackdrop,
    renderSettingsSheet,
    renderSleepTimerSheet,
    renderTrackActionsBackdrop,
    renderTrackActionsSheet
  };
}
