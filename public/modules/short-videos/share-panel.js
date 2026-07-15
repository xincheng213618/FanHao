export function createShortVideoSharePanel(deps) {
  const {
    bindShortVideoModalFocusLoop,
    cardTitle,
    closePlaybackSettings,
    copyShortVideoValue,
    createIcon,
    focusShortVideoTransientModal,
    formatDuration,
    formatShortVideoMetric,
    galleryLabel,
    getBrowser,
    isGalleryPost,
    isolateShortVideoTransientModal,
    localShortVideoUrl,
    originalDouyinUrl,
    shortVideoAuthorHandle,
    shortVideoShareText,
    showBrowserToast,
    state
  } = deps;

  function showSharePanel(video = state.shortVideo?.current, options = {}) {
    const browser = getBrowser();
    if (!browser || !video?.id) return;
    const existingOverlay = browser.querySelector(".short-video-more-overlay");
    if (existingOverlay) closePlaybackSettings(existingOverlay, { restoreFocus: false });
    browser.querySelector(".short-video-share-panel")?.remove();

    const localUrl = localShortVideoUrl(video);
    const originalUrl = originalDouyinUrl(video);
    const title = cardTitle(video) || "本地短视频";
    const authorName = String(video?.author?.name || "").trim();
    const shareText = shortVideoShareText(video, localUrl);

    const overlay = document.createElement("div");
    overlay.className = "short-video-more-overlay short-video-share-overlay";
    overlay._shortVideoReturnFocus = options.trigger || null;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closePlaybackSettings(overlay);
    });

    const sheet = document.createElement("section");
    sheet.className = "short-video-more-sheet short-video-share-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "short-video-share-title");
    sheet.tabIndex = -1;

    const header = document.createElement("header");
    header.className = "short-video-more-head";
    const headingWrap = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "分享作品";
    const heading = document.createElement("h2");
    heading.id = "short-video-share-title";
    heading.textContent = "发送给朋友";
    headingWrap.append(eyebrow, heading);
    const input = document.createElement("input");
    input.value = localUrl;
    input.readOnly = true;
    input.setAttribute("aria-label", "本地作品链接");
    input.addEventListener("focus", () => input.select());
    input.addEventListener("click", () => input.select());
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-more-close";
    close.append(createIcon("close"));
    close.setAttribute("aria-label", "关闭分享面板");
    close.addEventListener("click", () => closePlaybackSettings(overlay));
    header.append(headingWrap, close);

    const preview = document.createElement("section");
    preview.className = "short-video-share-preview";
    const media = document.createElement("span");
    media.className = "short-video-share-preview-media";
    if (video.coverUrl) {
      const image = document.createElement("img");
      image.src = video.coverUrl;
      image.alt = title;
      image.decoding = "async";
      media.append(image);
    } else {
      media.append(createIcon(isGalleryPost(video) ? "images" : "play"));
    }
    const mediaType = document.createElement("small");
    mediaType.textContent = isGalleryPost(video) ? `图集 · ${galleryLabel(video)}` : (formatDuration(video.durationMs) || "视频");
    media.append(mediaType);
    const previewCopy = document.createElement("div");
    const previewTitle = document.createElement("strong");
    previewTitle.textContent = title;
    const previewAuthor = document.createElement("span");
    previewAuthor.textContent = authorName ? shortVideoAuthorHandle(authorName) : "本地作品";
    const previewMeta = document.createElement("small");
    previewMeta.textContent = `${formatShortVideoMetric(video, "likes", "待补")} 赞 · ${formatShortVideoMetric(video, "comments", "待补")} 评论`;
    previewCopy.append(previewTitle, previewAuthor, previewMeta);
    preview.append(media, previewCopy);

    const actionSection = document.createElement("section");
    actionSection.className = "short-video-share-section";
    const actionTitle = document.createElement("strong");
    actionTitle.textContent = "分享方式";
    const actions = document.createElement("div");
    actions.className = "short-video-share-actions";

    const copyLocal = sharePanelAction("复制本地链接", "在这台设备或局域网打开", "link", async (button) => {
      await copyShortVideoValue(localUrl, "已复制本地链接");
      syncShareActionDone(button, "已复制");
    });
    copyLocal.classList.add("is-primary");
    const copyOriginal = sharePanelAction("复制抖音链接", originalUrl ? "打开原作品" : "当前作品没有原链接", "external", async (button) => {
      await copyShortVideoValue(originalUrl, "已复制抖音原链接");
      syncShareActionDone(button, "已复制");
    });
    copyOriginal.disabled = !originalUrl;
    const copyText = sharePanelAction("复制分享文案", "标题、作者和观看地址", "comment", async (button) => {
      await copyShortVideoValue(shareText, "已复制分享文案");
      syncShareActionDone(button, "已复制文案");
    });
    const systemShareAvailable = typeof navigator.share === "function";
    const systemShare = sharePanelAction("系统分享", systemShareAvailable ? "发送到其他应用" : "当前浏览器不支持", "share", async (button) => {
      if (!systemShareAvailable) return;
      try {
        await navigator.share({
          title,
          text: [title, authorName ? shortVideoAuthorHandle(authorName) : ""].filter(Boolean).join("\n"),
          url: localUrl
        });
        syncShareActionDone(button, "已打开分享");
      } catch (error) {
        if (error?.name !== "AbortError") showBrowserToast("系统分享启动失败");
      }
    });
    systemShare.disabled = !systemShareAvailable;
    actions.append(copyLocal, copyOriginal, copyText, systemShare);
    actionSection.append(actionTitle, actions);

    const linkSection = document.createElement("details");
    linkSection.className = "short-video-share-link";
    const linkSummary = document.createElement("summary");
    const linkLabel = document.createElement("strong");
    linkLabel.textContent = "查看本地地址";
    const linkHint = document.createElement("span");
    const localOnly = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
    linkHint.textContent = localOnly ? "仅这台设备可用" : "同一局域网可打开";
    linkSummary.append(linkLabel, linkHint);
    const linkField = document.createElement("div");
    const linkButton = document.createElement("button");
    linkButton.type = "button";
    linkButton.textContent = "复制";
    linkButton.addEventListener("click", () => {
      copyShortVideoValue(localUrl, "已复制本地链接").then(() => {
        linkButton.textContent = "已复制";
        window.setTimeout(() => {
          if (linkButton.isConnected) linkButton.textContent = "复制";
        }, 1800);
      }).catch(() => {
        input.focus({ preventScroll: true });
        input.select();
      });
    });
    linkField.append(input, linkButton);
    linkSection.append(linkSummary, linkField);

    const note = document.createElement("p");
    note.className = "short-video-share-note";
    note.append(createIcon("check"), document.createTextNode("分享只复制地址或调用系统面板，不会自动发布内容"));

    sheet.append(header, preview, actionSection, linkSection, note);
    overlay.append(sheet);
    browser.append(overlay);
    isolateShortVideoTransientModal(overlay);
    bindShortVideoModalFocusLoop(overlay, sheet, () => closePlaybackSettings(overlay));
    focusShortVideoTransientModal(sheet, copyLocal);
  }

  function sharePanelAction(label, description, icon, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-share-action";
    const visual = document.createElement("span");
    visual.append(createIcon(icon));
    const copy = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = label;
    const detail = document.createElement("small");
    detail.textContent = description;
    copy.append(title, detail);
    button.append(visual, copy);
    button.addEventListener("click", async () => {
      if (button.disabled || button.getAttribute("aria-busy") === "true") return;
      button.setAttribute("aria-busy", "true");
      try {
        await action?.(button);
      } catch (error) {
        console.warn(error);
      } finally {
        button.removeAttribute("aria-busy");
      }
    });
    return button;
  }

  function syncShareActionDone(button, detail) {
    if (!button) return;
    button.classList.add("is-done");
    const description = button.querySelector("small");
    const previous = description?.textContent || "";
    if (description) description.textContent = detail;
    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove("is-done");
      if (description) description.textContent = previous;
    }, 1800);
  }


  return showSharePanel;
}
