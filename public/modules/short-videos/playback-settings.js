export function createShortVideoPlaybackSettings(deps) {
  const {
    activePlayer,
    bindShortVideoModalFocusLoop,
    closePlaybackSettings,
    createIcon,
    deleteShortVideo,
    focusShortVideoTransientModal,
    formatPlaybackRate,
    getBrowser,
    getWorkGrid,
    isCurrentShortVideo,
    isGalleryPost,
    isolateShortVideoTransientModal,
    loadVideos,
    normalizePlaybackRate,
    openAdjacent,
    openDouyinLink,
    originalDouyinUrl,
    playbackRates,
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
  } = deps;

  function showPlaybackSettings(video = state.shortVideo?.current, options = {}) {
    const browser = getBrowser();
    if (!browser) return;
    const galleryMode = isGalleryPost(video);
    const existingOverlay = browser.querySelector(".short-video-more-overlay");
    if (existingOverlay) closePlaybackSettings(existingOverlay, { restoreFocus: false });

    const overlay = document.createElement("div");
    overlay.className = "short-video-more-overlay";
    overlay._shortVideoReturnFocus = options.trigger || null;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closePlaybackSettings(overlay);
    });

    const sheet = document.createElement("section");
    sheet.className = "short-video-more-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "short-video-playback-settings-title");
    sheet.tabIndex = -1;

    const header = document.createElement("header");
    header.className = "short-video-more-head";
    const headingWrap = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "本地播放器";
    const heading = document.createElement("h2");
    heading.id = "short-video-playback-settings-title";
    heading.textContent = "更多功能";
    headingWrap.append(eyebrow, heading);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-more-close";
    close.append(createIcon("close"));
    close.setAttribute("aria-label", "关闭更多功能");
    close.addEventListener("click", () => closePlaybackSettings(overlay));
    header.append(headingWrap, close);

    const speedSection = document.createElement("section");
    speedSection.className = "short-video-speed-section";
    const speedHead = document.createElement("div");
    const speedTitle = document.createElement("strong");
    speedTitle.textContent = "播放速度";
    const speedCurrent = document.createElement("span");
    speedHead.append(speedTitle, speedCurrent);
    const speedGrid = document.createElement("div");
    speedGrid.className = "short-video-speed-grid";
    const speedButtons = new Map();
    const syncSpeedButtons = () => {
      const currentRate = normalizePlaybackRate(state.shortVideo?.playbackRate);
      speedCurrent.textContent = `当前 ${formatPlaybackRate(currentRate)}`;
      for (const [value, button] of speedButtons) {
        const active = value === currentRate;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      }
    };
    for (const value of playbackRates) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = formatPlaybackRate(value);
      button.addEventListener("click", () => {
        setPlaybackRate(value);
        syncSpeedButtons();
      });
      speedButtons.set(value, button);
      speedGrid.append(button);
    }
    speedSection.append(speedHead, speedGrid);

    const actions = document.createElement("div");
    actions.className = "short-video-more-actions is-primary-actions";
    const player = activePlayer();
    const pictureInPictureAvailable = Boolean(player?.requestPictureInPicture && document.pictureInPictureEnabled);
    const pictureInPictureActive = Boolean(player && document.pictureInPictureElement === player);
    const pip = playbackSettingsAction(
      pictureInPictureActive ? "退出画中画" : "画中画",
      pictureInPictureAvailable ? "悬浮在其他窗口上方" : "当前作品不支持",
      "pictureInPicture",
      async () => {
        if (!pictureInPictureAvailable) return;
        closePlaybackSettings(overlay, { restoreFocus: false });
        try {
          if (pictureInPictureActive) await document.exitPictureInPicture();
          else await player.requestPictureInPicture();
        } catch {
          showBrowserToast("画中画启动失败");
        }
      }
    );
    pip.disabled = !pictureInPictureAvailable;

    const fullscreen = playbackSettingsAction("全屏播放", "沉浸观看当前作品", "fullscreen", () => {
      closePlaybackSettings(overlay, { restoreFocus: false });
      toggleShortVideoFullscreen();
    });
    fullscreen.dataset.shortVideoFullscreenControl = "settings";
    syncShortVideoFullscreenControl(fullscreen);

    const autoNext = playbackSettingsAction("连播", "播完自动切换下一条", "repeat", () => {
      state.shortVideo.autoNext = !state.shortVideo.autoNext;
      writeAutoNextPreference(state.shortVideo.autoNext);
      syncActivePlaybackMode();
      autoNext.classList.toggle("active", state.shortVideo.autoNext);
      autoNext.setAttribute("aria-pressed", String(state.shortVideo.autoNext));
      autoNext.querySelector("small").textContent = state.shortVideo.autoNext ? "已开启，播完切换下一条" : "播完自动切换下一条";
      getWorkGrid()?.querySelector?.(".short-video-control-auto")?.classList.toggle("active", state.shortVideo.autoNext);
    });
    autoNext.classList.toggle("active", Boolean(state.shortVideo.autoNext));
    autoNext.setAttribute("aria-pressed", String(Boolean(state.shortVideo.autoNext)));
    if (state.shortVideo.autoNext) autoNext.querySelector("small").textContent = "已开启，播完切换下一条";

    const clearScreenHint = window.matchMedia?.("(max-width: 680px)")?.matches
      ? "进入后轻触画面恢复"
      : "快捷键 J，再按恢复";
    const clearScreen = playbackSettingsAction("清屏播放", clearScreenHint, "clearScreen", () => {
      closePlaybackSettings(overlay, { restoreFocus: false });
      toggleClearScreen();
    });
    const copyLink = playbackSettingsAction("分享作品", "复制链接或打开系统分享", "link", () => {
      const returnFocus = overlay._shortVideoReturnFocus;
      closePlaybackSettings(overlay, { restoreFocus: false });
      shareShortVideo(video, { trigger: returnFocus });
    });
    const originalUrl = originalDouyinUrl(video);
    const original = playbackSettingsAction("抖音原视频", originalUrl ? "在新窗口打开" : "当前作品没有原始链接", "external", () => {
      closePlaybackSettings(overlay, { restoreFocus: false });
      openDouyinLink(video);
    });
    original.disabled = !originalUrl;
    const dislike = playbackSettingsAction(
      video?.actions?.disliked ? "撤销不感兴趣" : "不感兴趣",
      video?.actions?.disliked ? "重新允许出现在推荐中" : "减少此类内容推荐",
      "eyeOff",
      async () => {
        closePlaybackSettings(overlay, { restoreFocus: false });
        const disliked = await toggleShortVideoDislike(video);
        if (!disliked || state.shortVideo?.source !== "recommended" || !isCurrentShortVideo(video)) return;
        if (state.shortVideo.nextId) {
          openAdjacent(1).catch(showError);
          return;
        }
        state.shortVideo.current = null;
        state.shortVideo.data = null;
        loadVideos({ replaceRoute: true }).catch(showError);
      }
    );
    const deleteCurrent = playbackSettingsAction("删除作品", "删除本地记录与文件", "trash", () => {
      closePlaybackSettings(overlay, { restoreFocus: false });
      deleteShortVideo(video, { fromBrowser: true }).catch(showError);
    });
    deleteCurrent.classList.add("is-danger");
    const deleteGroup = playbackSettingsAction("删除同组", "清理同一文件夹作品", "folderTrash", () => {
      closePlaybackSettings(overlay, { restoreFocus: false });
      deleteShortVideo(video, { fromBrowser: true, scope: "group" }).catch(showError);
    });
    deleteGroup.classList.add("is-danger");
    const primarySection = document.createElement("section");
    primarySection.className = "short-video-more-section";
    const primaryTitle = document.createElement("strong");
    primaryTitle.textContent = "播放与分享";
    actions.append(pip, fullscreen, autoNext, clearScreen, copyLink, original);
    primarySection.append(primaryTitle, actions);

    const manageSection = document.createElement("section");
    manageSection.className = "short-video-more-section";
    const manageTitle = document.createElement("strong");
    manageTitle.textContent = "内容管理";
    const manageActions = document.createElement("div");
    manageActions.className = "short-video-more-actions is-manage-actions";
    manageActions.append(dislike, deleteCurrent, deleteGroup);
    manageSection.append(manageTitle, manageActions);

    const shortcuts = document.createElement("details");
    shortcuts.className = "short-video-shortcuts";
    const shortcutsSummary = document.createElement("summary");
    const shortcutsTitle = document.createElement("strong");
    shortcutsTitle.textContent = "快捷操作";
    const shortcutsHint = document.createElement("span");
    shortcutsHint.textContent = "键盘与手势";
    shortcutsSummary.append(shortcutsTitle, shortcutsHint);
    const shortcutGrid = document.createElement("div");
    const shortcutItems = [
      ["Space", galleryMode ? "播放 / 暂停图集" : "播放 / 暂停视频"],
      ["M", galleryMode ? "开启 / 关闭图集音乐" : "静音"],
      ["F", "进入 / 退出全屏"],
      ["J", "清屏"],
      ...(!galleryMode ? [["按住画面", "临时 2×，松开恢复"]] : []),
      ["双击画面", "点赞当前作品"],
      ["←  →", galleryMode ? "切换图集内容" : "视频快退 / 快进 5 秒"],
      ["↑  ↓", "切换作品"],
      ["Esc", "关闭 / 返回"]
    ];
    for (const [key, label] of shortcutItems) {
      const item = document.createElement("span");
      const keyboard = document.createElement("kbd");
      keyboard.textContent = key;
      item.append(keyboard, document.createTextNode(label));
      shortcutGrid.append(item);
    }
    shortcuts.append(shortcutsSummary, shortcutGrid);

    sheet.append(header);
    if (!galleryMode) sheet.append(speedSection);
    sheet.append(primarySection, manageSection, shortcuts);
    overlay.append(sheet);
    browser.append(overlay);
    isolateShortVideoTransientModal(overlay);
    bindShortVideoModalFocusLoop(overlay, sheet, () => closePlaybackSettings(overlay));
    if (!galleryMode) syncSpeedButtons();
    const initialFocus = options.focusSpeed && !galleryMode
      ? speedButtons.get(normalizePlaybackRate(state.shortVideo?.playbackRate))
      : close;
    focusShortVideoTransientModal(sheet, initialFocus);
  }

  function playbackSettingsAction(label, description, icon, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-more-action";
    const visual = document.createElement("span");
    visual.append(createIcon(icon));
    const copy = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = label;
    const detail = document.createElement("small");
    detail.textContent = description;
    copy.append(title, detail);
    button.append(visual, copy);
    button.addEventListener("click", action);
    return button;
  }


  return showPlaybackSettings;
}
