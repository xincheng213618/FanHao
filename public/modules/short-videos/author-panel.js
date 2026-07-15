export function createShortVideoAuthorPanel(deps) {
  const {
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
    currentAuthorPanelVideoRequestId,
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
    nextAuthorPanelVideoRequestId,
    normalizeShortVideoSortValue,
    normalizeShortVideoSound,
    normalizeShortVideoTopic,
    openAuthorDouyinLink,
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
    setAuthorPanelReturnFeed,
    setAuthorPanelTileMap,
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
  } = deps;

  async function showAuthorPanel(video, options = {}) {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    const existingPanel = browser.querySelector(".short-video-author-panel");
    if (existingPanel) closeAuthorPanel(existingPanel, { restoreFeed: false, restoreFocus: false, animate: false });
    closeTransientPlayerControls();
    setAuthorPanelReturnFeed(shortVideoFeedSnapshot());
    const author = video.author || {};
    const selectedTopic = normalizeShortVideoTopic(options.topic || video.tags?.[0]);
    const selectedSound = options.sound || video.sound || null;
    const panel = document.createElement("section");
    panel.className = "short-video-author-panel is-douyin-style";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel._shortVideoReturnFocus = document.activeElement;
    panel.dataset.returnFocusTab = String(options.initialTab || "works");
    panel.dataset.returnFocusTopic = selectedTopic;
    panel.setAttribute("aria-label", options.initialTab === "sound" && selectedSound
      ? `原声 ${selectedSound.title || "作品原声"}`
      : options.initialTab === "topic" && selectedTopic
      ? `话题 ${selectedTopic}`
      : options.initialTab === "comments"
      ? "评论与视频详情"
      : options.initialTab === "ai"
      ? "本地内容识别"
      : (options.initialTab === "related" ? "相关推荐" : "作者作品"));
    panel.addEventListener("click", (event) => {
      if (event.target === panel) closeAuthorPanel(panel);
    });

    const sheet = document.createElement("div");
    sheet.className = "short-video-author-sheet";
    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "short-video-author-drag-handle";
    dragHandle.setAttribute("aria-label", "向下拖动关闭面板");
    dragHandle.title = "下滑关闭";

    const top = document.createElement("div");
    top.className = "short-video-author-top";
    const tabNav = document.createElement("div");
    tabNav.className = "short-video-author-tab-nav";
    const tabs = document.createElement("div");
    tabs.className = "short-video-author-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "视频信息视图");
    const contextTabs = document.createElement("div");
    contextTabs.className = "short-video-author-context-tabs";
    contextTabs.setAttribute("role", "toolbar");
    contextTabs.setAttribute("aria-label", "扩展信息");
    const tabButtons = new Map();
    const primaryTabItems = [
      ["related", "相关推荐"],
      ["comments", `评论 ${formatShortVideoMetric(video, "comments")}`]
    ];
    const contextTabItems = [
      ["works", "作品"],
      ["detail", "详情"],
      ["ai", "识别"]
    ];
    if (selectedTopic) contextTabItems.push(["topic", `#${selectedTopic}`]);
    if (selectedSound) contextTabItems.push(["sound", "原声"]);
    const appendTabButton = (item, container, role = "tab") => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item[1];
      button.dataset.tab = item[0];
      button.setAttribute("role", role);
      button.addEventListener("click", () => renderAuthorTab(item[0], { userInitiated: true }));
      tabButtons.set(item[0], button);
      container.append(button);
    };
    primaryTabItems.forEach((item) => appendTabButton(item, tabs));
    contextTabItems.forEach((item) => appendTabButton(item, contextTabs, "button"));
    tabNav.append(tabs, contextTabs);
    const syncContextTabOverflow = () => {
      if (!contextTabs.isConnected) return;
      const overflow = contextTabs.scrollWidth > contextTabs.clientWidth + 2;
      const atStart = contextTabs.scrollLeft <= 2;
      const atEnd = contextTabs.scrollLeft + contextTabs.clientWidth >= contextTabs.scrollWidth - 2;
      contextTabs.classList.toggle("has-overflow", overflow);
      contextTabs.classList.toggle("is-scroll-start", !overflow || atStart);
      contextTabs.classList.toggle("is-scroll-end", !overflow || atEnd);
      contextTabs.setAttribute("aria-label", overflow ? "扩展信息，可横向滚动" : "扩展信息");
    };
    contextTabs.addEventListener("scroll", syncContextTabOverflow, { passive: true });
    if (typeof ResizeObserver === "function") {
      panel._shortVideoContextTabsObserver = new ResizeObserver(syncContextTabOverflow);
      panel._shortVideoContextTabsObserver.observe(contextTabs);
    }
    window.requestAnimationFrame(syncContextTabOverflow);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-author-close";
    close.append(createIcon("close"));
    close.setAttribute("aria-label", "关闭");
    close.addEventListener("click", () => closeAuthorPanel(panel));
    top.append(tabNav, close);

    const head = document.createElement("header");
    head.className = "short-video-author-head";
    head.append(authorAvatar(author, "short-video-author-head-avatar"));
    const title = document.createElement("div");
    title.className = "short-video-author-title";
    const name = document.createElement("strong");
    name.textContent = author.name || "未知作者";
    const profileLine = document.createElement("div");
    profileLine.className = "short-video-author-profile-line";
    const signature = document.createElement("div");
    signature.className = "short-video-author-profile-signature";
    const profileStats = document.createElement("div");
    profileStats.className = "short-video-author-profile-stats";
    const sub = document.createElement("span");
    sub.textContent = "读取中";
    title.append(name, profileLine, signature, profileStats, sub);
    const refreshAuthorHeader = () => {
      const lineText = authorProfileLineText(author);
      profileLine.textContent = lineText;
      profileLine.hidden = !lineText;
      const signatureText = String(author.signature || "").trim();
      renderAuthorSignature(signature, signatureText);
      signature.hidden = !signatureText;
      renderAuthorProfileStats(profileStats, author);
    };
    refreshAuthorHeader();

    const actions = document.createElement("div");
    actions.className = "short-video-author-actions";
    const follow = createAuthorFollowButton(video, author, "panel");
    const douyin = document.createElement("button");
    douyin.type = "button";
    douyin.textContent = "抖音主页";
    douyin.addEventListener("click", () => openAuthorDouyinLink(author));
    const authorPage = document.createElement("button");
    authorPage.type = "button";
    authorPage.textContent = "作者主页";
    authorPage.addEventListener("click", () => {
      closeAuthorPanel(panel, { restoreFeed: false });
      openShortVideoAuthorPage(author, video);
    });
    actions.append(follow, douyin, authorPage);
    head.append(title, actions);

    const content = document.createElement("div");
    content.className = "short-video-author-content";
    const status = document.createElement("div");
    status.className = "short-video-author-status";
    status.textContent = "正在读取";
    content.append(status);
    sheet.append(dragHandle, head, top, content);
    panel.append(sheet);
    browser.append(panel);
    bindAuthorPanelDragToClose(panel, sheet, dragHandle);
    isolateAuthorPanelAsMobileModal(panel, sheet, browser, close);

    let authorVideos = [];
    let authorTotal = 0;
    let authorVideosLoaded = false;
    let authorWorksLoading = false;
    let authorWorksError = "";
    let authorWorksRequestId = 0;
    let authorWorksSort = normalizeShortVideoSortValue(state.shortVideo.sort || "published");
    let authorFeedSwitchRequested = false;
    let activeTab = ["detail", "works", "comments", "ai", "sound", "topic", "related"].includes(options.initialTab)
      && (options.initialTab !== "topic" || selectedTopic)
      && (options.initialTab !== "sound" || selectedSound)
      ? options.initialTab
      : "works";
    const autoSwitchAuthorFeed = options.switchAuthorFeed !== false;
    let authorFeedSwitchStarted = false;
    let relatedItems = [];
    let relatedBasis = null;
    let relatedLoading = false;
    let relatedLoaded = false;
    let relatedError = "";
    let topicItems = [];
    let topicTotal = 0;
    let topicLoading = false;
    let topicLoaded = false;
    let topicError = "";
    let soundItems = [];
    let soundTotal = 0;
    let soundLoading = false;
    let soundLoaded = false;
    let soundError = "";
    const startAuthorFeedSwitch = () => {
      if (!panel.isConnected || authorFeedSwitchStarted || !authorScopeId(video, author)) return;
      if (!authorVideosLoaded) {
        authorFeedSwitchRequested = true;
        return;
      }
      authorFeedSwitchStarted = true;
      authorFeedSwitchRequested = false;
      switchToAuthorWorksFeed(video, author, panel, authorWorksSort).catch(showError);
    };
    const loadRelatedRecommendations = async (force = false) => {
      if (relatedLoading || (relatedLoaded && !force)) return;
      relatedLoading = true;
      relatedError = "";
      try {
        const data = await api(`/api/short-videos/${encodeURIComponent(video.id)}/related?limit=36`);
        if (!panel.isConnected) return;
        relatedItems = Array.isArray(data.videos) ? data.videos : [];
        for (const item of relatedItems) cacheAuthorPanelVideo(item);
        relatedBasis = data.basis || null;
        relatedLoaded = true;
      } catch (error) {
        if (!panel.isConnected) return;
        relatedError = shortVideoFriendlyError(error, "相关推荐读取失败");
      } finally {
        relatedLoading = false;
        if (panel.isConnected && ["related", "ai"].includes(activeTab)) renderAuthorTab(activeTab);
      }
    };
    const loadTopicWorks = async (force = false) => {
      if (!selectedTopic || topicLoading || (topicLoaded && !force)) return;
      topicLoading = true;
      topicError = "";
      try {
        const params = new URLSearchParams({
          topic: selectedTopic,
          source: "all",
          sort: "likes",
          limit: "36",
          facets: "0",
          stats: "0"
        });
        const data = await api(`/api/short-videos?${params}`);
        if (!panel.isConnected) return;
        topicItems = Array.isArray(data.videos) ? data.videos : [];
        topicTotal = Number(data.total || topicItems.length || 0);
        topicLoaded = true;
      } catch (error) {
        if (!panel.isConnected) return;
        topicError = shortVideoFriendlyError(error, "话题作品读取失败");
      } finally {
        topicLoading = false;
        if (panel.isConnected && activeTab === "topic") renderAuthorTab("topic");
      }
    };
    const loadSoundWorks = async (force = false) => {
      if (!selectedSound?.key || soundLoading || (soundLoaded && !force)) return;
      soundLoading = true;
      soundError = "";
      try {
        const params = new URLSearchParams({
          sound: selectedSound.key,
          source: "all",
          sort: "likes",
          limit: "36",
          facets: "0",
          stats: "0"
        });
        const data = await api(`/api/short-videos?${params}`);
        if (!panel.isConnected) return;
        soundItems = Array.isArray(data.videos) ? data.videos : [];
        soundTotal = Number(data.total || soundItems.length || 0);
        soundLoaded = true;
      } catch (error) {
        if (!panel.isConnected) return;
        soundError = shortVideoFriendlyError(error, "原声作品读取失败");
      } finally {
        soundLoading = false;
        if (panel.isConnected && activeTab === "sound") renderAuthorTab("sound");
      }
    };
    const loadAuthorWorks = async (requestedSort = authorWorksSort) => {
      const nextSort = normalizeShortVideoSortValue(requestedSort);
      const requestId = ++authorWorksRequestId;
      authorWorksSort = nextSort;
      state.shortVideo.sort = nextSort;
      authorWorksLoading = true;
      authorWorksError = "";
      if (panel.isConnected && activeTab === "works") renderAuthorTab("works");
      try {
        const params = new URLSearchParams();
        if (author.secUid) params.set("author", author.secUid);
        params.set("source", "all");
        params.set("sort", nextSort);
        params.set("limit", "36");
        params.set("facets", "0");
        params.set("stats", "0");
        const data = author.secUid ? await api(`/api/short-videos?${params}`) : { videos: [video], total: 1 };
        if (!panel.isConnected || requestId !== authorWorksRequestId) return;
        authorVideos = data.videos || [];
        authorTotal = Number(data.total || authorVideos.length || 0);
        authorVideosLoaded = true;
        cacheAuthorPanelVideos([video, ...authorVideos]);
        const richerAuthor = authorVideos.find((item) => authorHasProfileMeta(item.author))?.author || authorVideos[0]?.author;
        if (richerAuthor) Object.assign(author, richerAuthor);
        refreshAuthorHeader();
        const homeCount = profileNumber(author.awemeCount);
        sub.textContent = homeCount !== null
          ? `${formatNumber(authorTotal)} 个本地作品 / 主页 ${formatNumber(homeCount)}`
          : `${formatNumber(authorTotal)} 个本地作品`;
      } catch (error) {
        if (!panel.isConnected || requestId !== authorWorksRequestId) return;
        authorVideosLoaded = true;
        authorWorksError = shortVideoFriendlyError(error, "作者作品读取失败");
        if (authorFeedSwitchRequested && activeTab === "works") startAuthorFeedSwitch();
      } finally {
        if (!panel.isConnected || requestId !== authorWorksRequestId) return;
        authorWorksLoading = false;
        if (activeTab === "works" || activeTab === "detail") renderAuthorTab(activeTab);
      }
    };
    const renderAuthorTab = (tab, renderOptions = {}) => {
      activeTab = tab;
      panel.dataset.activeTab = tab;
      for (const [key, button] of tabButtons) {
        const selected = key === tab;
        button.classList.toggle("active", selected);
        if (button.getAttribute("role") === "tab") button.setAttribute("aria-selected", String(selected));
        else button.setAttribute("aria-pressed", String(selected));
      }
      try {
        setAuthorPanelTileMap(null);
        content.replaceChildren();
      if (tab === "works") {
        if (autoSwitchAuthorFeed || renderOptions.userInitiated) startAuthorFeedSwitch();
        content.append(authorWorksView(authorVideos, authorTotal, panel, state.shortVideo?.current || video, {
          sort: authorWorksSort,
          loading: authorWorksLoading || !authorVideosLoaded,
          error: authorWorksError,
          onSortChange: (nextSort) => loadAuthorWorks(nextSort)
        }));
        return;
      }
      if (tab === "detail") {
        content.append(authorDetailView(video, author));
        return;
      }
      if (tab === "comments") {
        content.append(lazyShortVideoCommentsView(video, panel));
        return;
      }
      if (tab === "ai") {
        content.append(shortVideoInsightView({
          videos: relatedItems,
          basis: relatedBasis,
          loading: relatedLoading,
          loaded: relatedLoaded,
          error: relatedError,
          onRetry: () => loadRelatedRecommendations(true),
          onShowRelated: () => renderAuthorTab("related", { userInitiated: true })
        }, panel, state.shortVideo?.current || video));
        if (!relatedLoaded && !relatedLoading) loadRelatedRecommendations().catch(() => {});
        return;
      }
      if (tab === "related") {
        content.append(shortVideoRelatedView({
          videos: relatedItems,
          basis: relatedBasis,
          loading: relatedLoading,
          loaded: relatedLoaded,
          error: relatedError,
          onRetry: () => loadRelatedRecommendations(true)
        }, panel, state.shortVideo?.current || video));
        if (!relatedLoaded && !relatedLoading) loadRelatedRecommendations().catch(() => {});
        return;
      }
      if (tab === "topic") {
        content.append(shortVideoTopicView({
          topic: selectedTopic,
          videos: topicItems,
          total: topicTotal,
          loading: topicLoading,
          loaded: topicLoaded,
          error: topicError,
          onRetry: () => loadTopicWorks(true)
        }, panel, state.shortVideo?.current || video));
        if (!topicLoaded && !topicLoading) loadTopicWorks().catch(() => {});
        return;
      }
      if (tab === "sound") {
        content.append(shortVideoSoundView({
          sound: selectedSound,
          videos: soundItems,
          total: soundTotal,
          loading: soundLoading,
          loaded: soundLoaded,
          error: soundError,
          onRetry: () => loadSoundWorks(true)
        }, panel, state.shortVideo?.current || video));
        if (!soundLoaded && !soundLoading) loadSoundWorks().catch(() => {});
        return;
      }
        content.append(authorComingSoonView("内容待接入"));
      } catch (error) {
        console.error("[short-video-author-panel]", error);
        const failure = document.createElement("div");
        failure.className = "short-video-author-status";
        failure.textContent = error?.message || "面板内容加载失败";
        content.replaceChildren(failure);
        showBrowserToast(failure.textContent);
      }
    };
    renderAuthorTab(activeTab);
    const commitPanelOpen = () => {
      if (!panel.isConnected || panel.dataset.openCommitted === "1") return;
      panel.dataset.openCommitted = "1";
      browser.classList.add("is-author-panel-open");
      panel.classList.add("is-open");
      const focusActiveTab = () => {
        if (!panel.isConnected) return;
        tabButtons.get(activeTab)?.focus?.({ preventScroll: true });
      };
      window.requestAnimationFrame(focusActiveTab);
      window.setTimeout(focusActiveTab, 100);
    };
    window.requestAnimationFrame(commitPanelOpen);
    window.setTimeout(commitPanelOpen, 80);

    loadAuthorWorks().catch(showError);
  }

  async function switchToAuthorWorksFeed(video, author = {}, panel = null, sort = state.shortVideo?.sort) {
    const authorId = authorScopeId(video, author);
    if (!authorId || !panel?.isConnected || !isCurrentShortVideo(video)) return;
    state.shortVideo.author = authorId;
    if (!isShortVideoAuthorDetailPage()) state.shortVideo.source = "all";
    state.shortVideo.query = "";
    state.shortVideo.topic = "";
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    if (!isShortVideoAuthorDetailPage()) state.shortVideo.sort = normalizeShortVideoSortValue(sort || "published");
    state.shortVideo.data = null;
    const data = await fetchShortVideoDetail(video.id);
    if (!panel.isConnected || !isCurrentShortVideo(video)) return;
    state.shortVideo.current = data.video || state.shortVideo.current;
    cacheAuthorPanelVideo(state.shortVideo.current);
    state.shortVideo.prevId = data.prevId || "";
    state.shortVideo.nextId = data.nextId || "";
    await loadAdjacentVideos(state.shortVideo.current.id);
    if (!panel.isConnected || !isCurrentShortVideo(video)) return;
    refreshAdjacentPanelsDom();
    syncShortVideoBrowserSearchDom();
    syncAuthorPanelCurrentTile();
    replaceRoute({ view: "shortVideos", shortVideoId: state.shortVideo.current.id });
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

  function authorWorksView(videos, total, panel, currentVideo = null, options = {}) {
    const wrap = document.createElement("div");
    wrap.className = "short-video-author-works";
    const heading = document.createElement("div");
    heading.className = "short-video-author-section-head";
    const label = document.createElement("div");
    label.className = "short-video-author-section-title";
    label.textContent = `${formatNumber(total || videos.length || 0)} 个作品`;
    const sort = document.createElement("select");
    sort.className = "short-video-author-sort-select";
    sort.setAttribute("aria-label", "作者作品排序");
    for (const item of [
      ["published", "时间倒序"],
      ["publishedAsc", "时间正序"],
      ["likes", "点赞最多"],
      ["likesAsc", "点赞最少"],
      ["comments", "评论最多"],
      ["duration", "时长最长"]
    ]) {
      const option = document.createElement("option");
      option.value = item[0];
      option.textContent = item[1];
      sort.append(option);
    }
    sort.value = normalizeShortVideoSortValue(options.sort || "published");
    sort.disabled = Boolean(options.loading);
    sort.addEventListener("change", () => options.onSortChange?.(sort.value));
    heading.append(label, sort);
    const grid = document.createElement("div");
    grid.className = "short-video-author-grid";
    const tileMap = new Map();
    const displayVideos = shortVideosWithCovers(videos);
    if (options.error) {
      const error = document.createElement("div");
      error.className = "short-video-author-status is-error";
      error.textContent = options.error;
      grid.append(error);
    } else if (options.loading && !displayVideos.length) {
      const loading = document.createElement("div");
      loading.className = "short-video-author-status is-loading";
      loading.textContent = "正在按所选顺序读取作品";
      grid.append(loading);
    } else if (!displayVideos.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-author-status";
      empty.textContent = videos.length ? "封面补齐前暂不显示这些短视频。" : "没有视频";
      grid.append(empty);
    } else {
      for (const [index, item] of displayVideos.entries()) {
        const tile = authorVideoTile(item, panel, index, {
          current: isCurrentShortVideo(item, currentVideo),
          previous: displayVideos[index - 1] || null,
          next: displayVideos[index + 1] || null
        });
        if (tile) {
          const id = String(item.id || "").trim();
          const awemeId = String(item.awemeId || "").trim();
          if (id) tileMap.set(`id:${id}`, tile);
          if (awemeId) tileMap.set(`aweme:${awemeId}`, tile);
          grid.append(tile);
        }
      }
    }
    setAuthorPanelTileMap(tileMap);
    activateShortVideoCovers(grid);
    wrap.append(heading, grid);
    return wrap;
  }

  function authorDetailView(video, author) {
    const detail = document.createElement("div");
    detail.className = "short-video-author-detail";
    const authorLine = document.createElement("button");
    authorLine.type = "button";
    authorLine.className = "short-video-author-detail-owner";
    authorLine.textContent = `${shortVideoAuthorHandle(author.name)} ›`;
    authorLine.addEventListener("click", () => openAuthorDouyinLink(author));
    const profile = authorProfileBlock(author);
    const title = document.createElement("p");
    appendCaptionText(title, captionTitleWithTags(video), video);
    const stats = document.createElement("div");
    stats.className = "short-video-author-detail-stats";
    for (const item of [
      ["点赞", formatShortVideoMetric(video, "likes", "待补")],
      ["评论", formatShortVideoMetric(video, "comments", "待补")],
      ["收藏", formatShortVideoMetric(video, "collects", "待补")],
      ["分享", formatShortVideoMetric(video, "shares", "待补")],
      [isGalleryPost(video) ? "图片" : "时长", isGalleryPost(video) ? galleryLabel(video) : (formatDuration(video.durationMs) || "-")],
      ["大小", formatBytes(video.size || 0) || "-"]
    ]) {
      const cell = document.createElement("span");
      const value = document.createElement("b");
      value.textContent = item[1];
      const label = document.createElement("small");
      label.textContent = item[0];
      cell.append(value, label);
      stats.append(cell);
    }
    const actions = document.createElement("div");
    actions.className = "short-video-author-detail-actions";
    const original = document.createElement("button");
    original.type = "button";
    original.textContent = "打开原视频";
    original.addEventListener("click", () => openDouyinLink(video));
    const home = document.createElement("button");
    home.type = "button";
    home.textContent = "打开抖音主页";
    home.addEventListener("click", () => openAuthorDouyinLink(author));
    actions.append(original, home);
    detail.append(authorLine);
    if (profile) detail.append(profile);
    detail.append(title, stats, actions);
    return detail;
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

  function renderAuthorProfileStats(target, author) {
    target.textContent = "";
    const items = profileStatItems(author);
    target.hidden = !items.length;
    for (const [label, value] of items) {
      const cell = document.createElement("span");
      cell.dataset.profileStat = label;
      const strong = document.createElement("b");
      strong.textContent = formatCompact(value);
      const small = document.createElement("small");
      small.textContent = label;
      cell.append(strong, small);
      target.append(cell);
    }
  }

  function authorProfileBlock(author) {
    if (!authorHasProfileMeta(author)) return null;
    const block = document.createElement("div");
    block.className = "short-video-author-profile-block";
    const lineText = authorProfileLineText(author);
    if (lineText) {
      const line = document.createElement("div");
      line.className = "short-video-author-profile-line";
      line.textContent = lineText;
      block.append(line);
    }
    const signature = String(author?.signature || "").trim();
    if (signature) {
      const bio = document.createElement("div");
      bio.className = "short-video-author-profile-signature";
      renderAuthorSignature(bio, signature);
      block.append(bio);
    }
    const stats = document.createElement("div");
    stats.className = "short-video-author-profile-stats";
    renderAuthorProfileStats(stats, author);
    if (!stats.hidden) block.append(stats);
    return block;
  }

  function shortVideoSoundView(data = {}, panel, currentVideo) {
    const sound = data.sound || currentVideo?.sound || {};
    const wrap = document.createElement("div");
    wrap.className = "short-video-sound";
    const heading = document.createElement("div");
    heading.className = "short-video-sound-heading";
    const cover = document.createElement("span");
    cover.className = "short-video-sound-cover";
    if (sound.coverUrl) {
      const image = document.createElement("img");
      image.src = sound.coverUrl;
      image.alt = `${sound.title || "原声"}封面`;
      image.decoding = "async";
      cover.append(image);
    } else {
      cover.append(createIcon("headphones"));
    }
    const copy = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = sound.localAvailable ? "本地原声" : "作品原声";
    const title = document.createElement("strong");
    title.textContent = sound.title || "作品原声";
    const author = document.createElement("small");
    author.textContent = [sound.author ? `音乐人 ${sound.author}` : "", data.loaded ? `${formatNumber(data.total || 0)} 个作品` : "正在统计"].filter(Boolean).join(" · ");
    copy.append(eyebrow, title, author);
    const actions = document.createElement("div");
    actions.className = "short-video-sound-actions";
    let audio = null;
    let preview = null;
    if (sound.previewUrl) {
      audio = document.createElement("audio");
      audio.className = "short-video-sound-audio";
      audio.src = sound.previewUrl;
      audio.preload = "metadata";
      preview = document.createElement("button");
      preview.type = "button";
      preview.textContent = sound.localAvailable ? "播放本地原声" : "试听原声";
      const syncPreview = () => {
        const playing = !audio.paused && !audio.ended;
        preview.textContent = playing ? "暂停原声" : (sound.localAvailable ? "播放本地原声" : "试听原声");
        cover.classList.toggle("is-playing", playing);
      };
      audio.addEventListener("play", syncPreview);
      audio.addEventListener("pause", syncPreview);
      audio.addEventListener("ended", syncPreview);
      audio.addEventListener("error", () => {
        preview.disabled = true;
        preview.textContent = "原声暂不可播放";
        cover.classList.remove("is-playing");
      });
      preview.addEventListener("click", async () => {
        if (audio.paused) {
          activePlayer()?.pause?.();
          try {
            await audio.play();
          } catch (error) {
            showBrowserToast(error?.name === "NotAllowedError"
              ? "浏览器拦截了播放，请再次点击试听"
              : "原声暂时无法播放");
          }
        } else {
          audio.pause();
        }
        syncPreview();
      });
      actions.append(preview, audio);
    }
    const enter = document.createElement("button");
    enter.type = "button";
    enter.className = "is-primary";
    enter.textContent = "进入原声流";
    enter.disabled = !sound.key || data.loading;
    enter.addEventListener("click", () => enterShortVideoSoundFeed(sound, currentVideo, panel).catch(showError));
    actions.append(enter);
    heading.append(cover, copy, actions);
    wrap.append(heading);

    if (data.error) {
      const error = document.createElement("div");
      error.className = "short-video-related-status is-error";
      const message = document.createElement("span");
      message.textContent = data.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载";
      retry.addEventListener("click", () => data.onRetry?.());
      error.append(message, retry);
      wrap.append(error);
      return wrap;
    }
    if (data.loading || !data.loaded) {
      const loading = document.createElement("div");
      loading.className = "short-video-related-status is-loading";
      loading.append(createIcon("repeat"), document.createTextNode("正在读取同原声作品"));
      wrap.append(loading);
      return wrap;
    }
    const videos = shortVideosWithCovers(Array.isArray(data.videos) ? data.videos : []);
    if (!videos.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-related-status";
      empty.textContent = "本地库暂时没有同原声作品";
      wrap.append(empty);
      return wrap;
    }
    const grid = document.createElement("div");
    grid.className = "short-video-author-grid short-video-sound-grid";
    for (const [index, video] of videos.entries()) {
      const tile = authorVideoTile(video, panel, index, {
        current: isCurrentShortVideo(video, currentVideo),
        previous: videos[index - 1] || null,
        next: videos[index + 1] || null,
        onOpen: (item, sourcePanel) => enterShortVideoSoundFeed(sound, item, sourcePanel)
      });
      if (tile) grid.append(tile);
    }
    activateShortVideoCovers(grid);
    wrap.append(grid);
    return wrap;
  }

  async function enterShortVideoSoundFeed(sound, targetVideo, panel) {
    const key = normalizeShortVideoSound(sound?.key);
    const video = targetVideo || state.shortVideo?.current;
    if (!key || !video?.id) return;
    setAuthorPanelReturnFeed(null);
    state.shortVideo.authorPage = "";
    state.shortVideo.author = "all";
    state.shortVideo.source = "all";
    state.shortVideo.sort = "likes";
    state.shortVideo.query = "";
    state.shortVideo.topic = "";
    state.shortVideo.sound = key;
    state.shortVideo.soundInfo = sound;
    state.shortVideo.media = "all";
    state.shortVideo.quality = "all";
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();

    if (isCurrentShortVideo(video)) {
      const data = await fetchShortVideoDetail(video.id);
      if (!isCurrentShortVideo(video)) return;
      state.shortVideo.current = data.video || video;
      state.shortVideo.prevId = data.prevId || "";
      state.shortVideo.nextId = data.nextId || "";
      await loadAdjacentVideos(video.id);
      if (!isCurrentShortVideo(video)) return;
      renderStats();
      refreshAdjacentPanelsDom();
      syncCurrentNavigationDom();
    } else {
      await replaceVideoFromAuthorPanel(video, panel);
    }
    syncShortVideoBrowserSearchDom();
    if (panel?.isConnected) closeAuthorPanel(panel, { restoreFeed: false });
    replaceRoute({ view: "shortVideos", shortVideoId: state.shortVideo.current?.id || video.id });
    showBrowserToast(`已进入原声：${sound.title || "作品原声"}`);
  }

  function shortVideoTopicView(data = {}, panel, currentVideo) {
    const topic = normalizeShortVideoTopic(data.topic);
    const wrap = document.createElement("div");
    wrap.className = "short-video-topic";
    const heading = document.createElement("div");
    heading.className = "short-video-topic-heading";
    const copy = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "本地话题";
    const title = document.createElement("strong");
    title.textContent = `#${topic}`;
    const count = document.createElement("small");
    count.textContent = data.loaded ? `${formatNumber(data.total || 0)} 个作品` : "正在统计";
    copy.append(eyebrow, title, count);
    const enter = document.createElement("button");
    enter.type = "button";
    enter.textContent = "进入话题流";
    enter.disabled = !topic || data.loading;
    enter.addEventListener("click", () => enterShortVideoTopicFeed(topic, currentVideo, panel).catch(showError));
    heading.append(copy, enter);
    wrap.append(heading);

    if (data.error) {
      const error = document.createElement("div");
      error.className = "short-video-related-status is-error";
      const message = document.createElement("span");
      message.textContent = data.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载";
      retry.addEventListener("click", () => data.onRetry?.());
      error.append(message, retry);
      wrap.append(error);
      return wrap;
    }
    if (data.loading || !data.loaded) {
      const loading = document.createElement("div");
      loading.className = "short-video-related-status is-loading";
      loading.append(createIcon("repeat"), document.createTextNode("正在读取同话题作品"));
      wrap.append(loading);
      return wrap;
    }
    const videos = shortVideosWithCovers(Array.isArray(data.videos) ? data.videos : []);
    if (!videos.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-related-status";
      empty.textContent = "本地库暂时没有同话题作品";
      wrap.append(empty);
      return wrap;
    }
    const grid = document.createElement("div");
    grid.className = "short-video-author-grid short-video-topic-grid";
    for (const [index, video] of videos.entries()) {
      const tile = authorVideoTile(video, panel, index, {
        current: isCurrentShortVideo(video, currentVideo),
        previous: videos[index - 1] || null,
        next: videos[index + 1] || null,
        onOpen: (item, sourcePanel) => enterShortVideoTopicFeed(topic, item, sourcePanel)
      });
      if (tile) grid.append(tile);
    }
    activateShortVideoCovers(grid);
    wrap.append(grid);
    return wrap;
  }

  async function enterShortVideoTopicFeed(value, targetVideo, panel) {
    const topic = normalizeShortVideoTopic(value);
    const video = targetVideo || state.shortVideo?.current;
    if (!topic || !video?.id) return;
    setAuthorPanelReturnFeed(null);
    state.shortVideo.authorPage = "";
    state.shortVideo.author = "all";
    state.shortVideo.source = "all";
    state.shortVideo.sort = "likes";
    state.shortVideo.query = "";
    state.shortVideo.topic = topic;
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    state.shortVideo.media = "all";
    state.shortVideo.quality = "all";
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();

    if (isCurrentShortVideo(video)) {
      const data = await fetchShortVideoDetail(video.id);
      if (!isCurrentShortVideo(video)) return;
      state.shortVideo.current = data.video || video;
      state.shortVideo.prevId = data.prevId || "";
      state.shortVideo.nextId = data.nextId || "";
      await loadAdjacentVideos(video.id);
      if (!isCurrentShortVideo(video)) return;
      renderStats();
      refreshAdjacentPanelsDom();
      syncCurrentNavigationDom();
    } else {
      await replaceVideoFromAuthorPanel(video, panel);
    }
    syncShortVideoBrowserSearchDom();
    if (panel?.isConnected) closeAuthorPanel(panel, { restoreFeed: false });
    replaceRoute({ view: "shortVideos", shortVideoId: state.shortVideo.current?.id || video.id });
    showBrowserToast(`已进入 #${topic}`);
  }

  function shortVideoInsightQuery(video = {}) {
    const cleanTitle = String(video.title || video.description || "")
      .replace(/#[^\s#@]+/gu, " ")
      .replace(/@[^\s#@]+/gu, " ")
      .replace(/[|｜]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (cleanTitle) return cleanTitle.slice(0, 32);
    const firstTag = normalizeShortVideoTopic(video.tags?.[0]);
    return firstTag || String(video.author?.name || "").trim().slice(0, 32);
  }

  function shortVideoFrameLabel(video = {}) {
    const width = Math.max(0, Number(video.width || 0));
    const height = Math.max(0, Number(video.height || 0));
    if (!width || !height) return "规格未知";
    const orientation = Math.abs(width - height) < Math.max(width, height) * 0.04
      ? "方形"
      : (width > height ? "横屏" : "竖屏");
    return `${orientation} · ${width}×${height}`;
  }

  function shortVideoInsightView(data = {}, panel, currentVideo = {}) {
    const video = currentVideo || {};
    const gallery = isGalleryPost(video);
    const query = shortVideoInsightQuery(video);
    const tags = [...new Set((Array.isArray(video.tags) ? video.tags : [])
      .map(normalizeShortVideoTopic)
      .filter(Boolean))].slice(0, 8);
    const wrap = document.createElement("div");
    wrap.className = "short-video-insight";

    const hero = document.createElement("section");
    hero.className = "short-video-insight-hero";
    const media = document.createElement("div");
    media.className = "short-video-insight-media";
    const coverUrl = shortVideoCardCoverUrl(video);
    if (coverUrl) {
      const cover = document.createElement("img");
      cover.className = "short-video-cover-image";
      cover.dataset.src = coverUrl;
      cover.dataset.videoId = String(video.id || "");
      cover.alt = gallery ? "当前图文封面" : "当前视频封面";
      cover.loading = "eager";
      cover.decoding = "async";
      media.append(cover);
    }
    const mediaBadge = document.createElement("span");
    mediaBadge.textContent = gallery ? `图集 · ${galleryLabel(video)}` : "短视频";
    media.append(mediaBadge);

    const heroCopy = document.createElement("div");
    heroCopy.className = "short-video-insight-hero-copy";
    const eyebrow = document.createElement("span");
    eyebrow.className = "short-video-insight-eyebrow";
    eyebrow.append(createIcon("ai"), document.createTextNode("本地内容识别"));
    const privacy = document.createElement("em");
    privacy.textContent = "未上传云端";
    eyebrow.append(privacy);
    const title = document.createElement("strong");
    title.textContent = cardTitle(video);
    const note = document.createElement("p");
    note.textContent = "根据本地标题、标签、作者与媒体信息整理，不虚构画面结论。";
    heroCopy.append(eyebrow, title, note);
    hero.append(media, heroCopy);

    const facts = document.createElement("div");
    facts.className = "short-video-insight-facts";
    const factItems = [
      ["内容类型", gallery ? "图文作品" : "视频作品"],
      ["画面规格", shortVideoFrameLabel(video)],
      [gallery ? "图片数量" : "视频时长", gallery ? galleryLabel(video) : (formatDuration(video.durationMs) || "未知")],
      ["发布时间", formatDate(video.publishedAt) || "日期未知"]
    ];
    for (const [labelText, valueText] of factItems) {
      const fact = document.createElement("span");
      const value = document.createElement("b");
      value.textContent = valueText;
      const label = document.createElement("small");
      label.textContent = labelText;
      fact.append(value, label);
      facts.append(fact);
    }

    const clues = document.createElement("section");
    clues.className = "short-video-insight-section";
    const cluesHeading = document.createElement("div");
    cluesHeading.className = "short-video-insight-section-heading";
    const cluesTitle = document.createElement("strong");
    cluesTitle.textContent = "内容线索";
    const cluesHint = document.createElement("span");
    cluesHint.textContent = "点击线索继续探索";
    cluesHeading.append(cluesTitle, cluesHint);
    const chips = document.createElement("div");
    chips.className = "short-video-insight-chips";
    for (const topic of tags) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = `#${topic}`;
      chip.addEventListener("click", () => showAuthorPanel(video, {
        initialTab: "topic",
        topic,
        switchAuthorFeed: false
      }).catch(showError));
      chips.append(chip);
    }
    if (video.author?.name) {
      const author = document.createElement("button");
      author.type = "button";
      author.textContent = shortVideoAuthorHandle(video.author.name);
      author.addEventListener("click", () => {
        closeAuthorPanel(panel, { restoreFeed: false });
        openShortVideoAuthorPage(video.author, video);
      });
      chips.append(author);
    }
    if (!chips.childElementCount) {
      const empty = document.createElement("span");
      empty.className = "short-video-insight-empty-clue";
      empty.textContent = "这条作品没有记录可用的话题或作者线索。";
      chips.append(empty);
    }
    clues.append(cluesHeading, chips);

    const actions = document.createElement("div");
    actions.className = "short-video-insight-actions";
    const search = document.createElement("button");
    search.type = "button";
    search.className = "is-primary";
    search.textContent = query ? `搜索“${query}”` : "搜索相关内容";
    search.disabled = !query;
    search.addEventListener("click", () => {
      closeAuthorPanel(panel, { restoreFeed: false });
      commitShortVideoSearch(query);
    });
    const related = document.createElement("button");
    related.type = "button";
    related.textContent = data.loading ? "正在匹配相似作品" : "查看全部相关推荐";
    related.addEventListener("click", () => data.onShowRelated?.());
    actions.append(search, related);

    const recommendation = document.createElement("section");
    recommendation.className = "short-video-insight-section short-video-insight-recommendations";
    const recommendationHeading = document.createElement("div");
    recommendationHeading.className = "short-video-insight-section-heading";
    const recommendationTitle = document.createElement("strong");
    recommendationTitle.textContent = "相似作品";
    const recommendationBasis = document.createElement("span");
    const basisTags = Array.isArray(data.basis?.tags) ? data.basis.tags.filter(Boolean).slice(0, 2) : [];
    recommendationBasis.textContent = basisTags.length
      ? `基于 ${basisTags.map((tag) => `#${tag}`).join(" · ")}`
      : `基于 ${data.basis?.author || video.author?.name || "当前作品"}`;
    recommendationHeading.append(recommendationTitle, recommendationBasis);
    recommendation.append(recommendationHeading);

    if (data.error) {
      const error = document.createElement("div");
      error.className = "short-video-insight-recommendation-status";
      const message = document.createElement("span");
      message.textContent = data.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新匹配";
      retry.addEventListener("click", () => data.onRetry?.());
      error.append(message, retry);
      recommendation.append(error);
    } else if (data.loading || !data.loaded) {
      const loading = document.createElement("div");
      loading.className = "short-video-insight-recommendation-status is-loading";
      loading.append(createIcon("repeat"), document.createTextNode("正在匹配本地作品"));
      recommendation.append(loading);
    } else {
      const videos = shortVideosWithCovers(Array.isArray(data.videos) ? data.videos : []).slice(0, 3);
      if (!videos.length) {
        const empty = document.createElement("div");
        empty.className = "short-video-insight-recommendation-status";
        empty.textContent = "本地库暂时没有相似作品";
        recommendation.append(empty);
      } else {
        const list = document.createElement("div");
        list.className = "short-video-insight-recommendation-list";
        for (const [index, item] of videos.entries()) {
          const button = document.createElement("button");
          button.type = "button";
          button.setAttribute("aria-label", `播放相似作品：${cardTitle(item)}`);
          const itemMedia = document.createElement("span");
          const image = document.createElement("img");
          image.className = "short-video-cover-image";
          image.dataset.src = shortVideoCardCoverUrl(item);
          image.dataset.videoId = String(item.id || "");
          image.alt = item.title || "相似作品封面";
          image.loading = index === 0 ? "eager" : "lazy";
          image.decoding = "async";
          itemMedia.append(image);
          const copy = document.createElement("span");
          const itemTitle = document.createElement("strong");
          itemTitle.textContent = cardTitle(item);
          const reason = document.createElement("small");
          reason.textContent = item.recommendation?.reason || shortVideoAuthorHandle(item.author?.name);
          copy.append(itemTitle, reason);
          button.append(itemMedia, copy);
          button.addEventListener("click", () => openRelatedVideo(item, panel));
          list.append(button);
        }
        recommendation.append(list);
      }
    }

    wrap.append(hero, facts, clues, actions, recommendation);
    activateShortVideoCovers(wrap);
    return wrap;
  }

  function shortVideoRelatedView(data = {}, panel, currentVideo) {
    const wrap = document.createElement("div");
    wrap.className = "short-video-related";
    const summary = document.createElement("div");
    summary.className = "short-video-related-summary";
    const basis = document.createElement("span");
    const basisTags = Array.isArray(data.basis?.tags) ? data.basis.tags.filter(Boolean).slice(0, 2) : [];
    basis.textContent = basisTags.length
      ? `基于 ${basisTags.map((tag) => `#${tag}`).join(" · ")}`
      : `基于 ${data.basis?.author || currentVideo?.author?.name || "当前作品"}`;
    summary.append(basis);
    wrap.append(summary);

    if (data.error) {
      const error = document.createElement("div");
      error.className = "short-video-related-status is-error";
      const message = document.createElement("span");
      message.textContent = data.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载";
      retry.addEventListener("click", () => data.onRetry?.());
      error.append(message, retry);
      wrap.append(error);
      return wrap;
    }
    if (data.loading || !data.loaded) {
      const loading = document.createElement("div");
      loading.className = "short-video-related-status is-loading";
      loading.append(createIcon("repeat"), document.createTextNode("正在匹配本地作品"));
      wrap.append(loading);
      return wrap;
    }

    const candidates = shortVideosWithCovers([
      currentVideo,
      ...(Array.isArray(data.videos) ? data.videos : [])
    ].filter(Boolean));
    const seen = new Set();
    const videos = candidates.filter((item) => {
      const key = String(item?.id || item?.awemeId || "").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const recommendations = videos.filter((item) => !isCurrentShortVideo(item, currentVideo));
    if (!recommendations.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-related-status";
      empty.textContent = "暂时没有可展示的本地相关推荐";
      wrap.append(empty);
      return wrap;
    }

    const count = document.createElement("strong");
    count.textContent = `${formatNumber(recommendations.length)} 条本地推荐`;
    summary.append(count);
    const list = document.createElement("div");
    list.className = "short-video-related-list";
    for (const [index, video] of videos.entries()) {
      const isCurrent = isCurrentShortVideo(video, currentVideo);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-related-item";
      button.classList.toggle("is-current", isCurrent);
      button.dataset.videoId = String(video.id || "");
      button.dataset.awemeId = String(video.awemeId || "");
      if (isCurrent) button.setAttribute("aria-current", "true");
      button.setAttribute("aria-label", `播放推荐：${cardTitle(video)}`);
      const media = document.createElement("span");
      media.className = "short-video-related-media";
      const img = document.createElement("img");
      img.className = "short-video-cover-image";
      img.dataset.src = shortVideoCardCoverUrl(video);
      img.dataset.videoId = video.id;
      img.alt = video.title || "推荐作品封面";
      img.loading = index < 5 ? "eager" : "lazy";
      img.decoding = "async";
      img.fetchPriority = index < 3 ? "high" : "low";
      const type = document.createElement("em");
      type.textContent = isGalleryPost(video) ? galleryLabel(video) : (formatDuration(video.durationMs) || "视频");
      media.append(img, type);
      if (isCurrent) {
        const current = document.createElement("span");
        current.className = "short-video-related-current";
        current.textContent = "播放中";
        media.append(current);
      }

      const copy = document.createElement("span");
      copy.className = "short-video-related-copy";
      const itemTitle = document.createElement("strong");
      itemTitle.textContent = cardTitle(video);
      const metrics = document.createElement("small");
      metrics.className = "short-video-related-meta";
      const likes = document.createElement("span");
      likes.append(createIcon("heart"), document.createTextNode(formatShortVideoMetric(video, "likes")));
      applyShortVideoLikeBadgeState(likes, video);
      const author = document.createElement("span");
      author.className = "short-video-related-author";
      author.textContent = video.author?.name || "未知作者";
      metrics.append(likes, author);
      copy.append(itemTitle, metrics);
      button.append(media, copy);
      const warmRelatedItem = () => {
        if (isCurrent || button.dataset.prefetchStarted === "1" || !button.isConnected) return;
        button.dataset.prefetchStarted = "1";
        button.classList.add("is-prefetching");
        prefetchRelatedVideo(video).then((detail) => {
          if (!button.isConnected || !detail?.video) return;
          button.dataset.detailReady = "1";
          button.classList.add("is-prefetched");
        }).catch(() => {}).finally(() => {
          button.classList.remove("is-prefetching");
        });
      };
      button.addEventListener("pointerenter", warmRelatedItem, { once: true });
      button.addEventListener("focus", warmRelatedItem, { once: true });
      if (!isCurrent && index <= 4) {
        if (typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(warmRelatedItem, { timeout: 900 });
        } else {
          window.setTimeout(warmRelatedItem, 80 + index * 55);
        }
      }
      button.addEventListener("click", async () => {
        button.classList.add("is-opening");
        panel?.classList.add("is-switching-video");
        try {
          await openRelatedVideo(video, panel, {
            previous: videos[index - 1] || null,
            next: videos[index + 1] || null
          });
        } finally {
          button.classList.remove("is-opening");
          panel?.classList.remove("is-switching-video");
        }
      });
      list.append(button);
    }
    activateShortVideoCovers(list);
    wrap.append(list);
    return wrap;
  }

  async function openRelatedVideo(video, panel, neighbors = {}) {
    if (!video?.id) return;
    if (isCurrentShortVideo(video)) {
      showBrowserToast("正在观看这条");
      return;
    }
    const resolved = resolvedShortVideoDetail(video.id);
    await replaceVideoFromAuthorPanel(resolved?.video || video, panel, neighbors);
  }

  function authorComingSoonView(text) {
    const box = document.createElement("div");
    box.className = "short-video-author-status";
    box.textContent = text;
    return box;
  }

  function authorVideoTile(video, panel, index = 0, options = {}) {
    const isCurrent = Boolean(options.current);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-author-tile";
    button.classList.toggle("is-current", isCurrent);
    button.dataset.videoId = String(video.id || "");
    button.dataset.awemeId = String(video.awemeId || "");
    button.setAttribute("aria-label", video.title || "打开短视频");
    if (isCurrent) button.setAttribute("aria-current", "true");
    const media = document.createElement("span");
    media.className = "short-video-author-tile-media";
    const coverUrl = shortVideoCardCoverUrl(video);
    if (!coverUrl) return null;
    const img = document.createElement("img");
    img.className = "short-video-cover-image";
    img.dataset.src = coverUrl;
    img.dataset.videoId = video.id;
    img.alt = video.title || "短视频封面";
    img.loading = index < coverEagerCount ? "eager" : "lazy";
    img.decoding = "async";
    img.fetchPriority = index < 8 ? "high" : "low";
    media.append(img);
    const meta = document.createElement("span");
    meta.className = "short-video-author-tile-meta";
    const like = document.createElement("span");
    like.className = "short-video-like-badge";
    like.append(createIcon("heart"), document.createTextNode(formatShortVideoMetric(video, "likes")));
    applyShortVideoLikeBadgeState(like, video);
    if (video.actions?.liked) {
      button.setAttribute("aria-label", `${video.title || "打开短视频"}，已点赞`);
    }
    if (isCurrent) {
      const currentBadge = document.createElement("span");
      currentBadge.className = "short-video-author-current-badge";
      currentBadge.textContent = "当前观看";
      media.append(currentBadge);
    }
    media.append(like);
    if (isGalleryPost(video)) media.append(galleryBadge(video));
    meta.textContent = cardTitle(video);
    button.append(media, meta);
    button.addEventListener("click", () => {
      if (isCurrentShortVideo(video)) {
        showBrowserToast("正在观看这条");
        return;
      }
      if (typeof options.onOpen === "function") {
        Promise.resolve(options.onOpen(video, panel, {
          previous: options.previous || null,
          next: options.next || null
        })).catch(showError);
        return;
      }
      replaceVideoFromAuthorPanel(video, panel, {
        previous: options.previous || null,
        next: options.next || null
      }).catch(showError);
    });
    return button;
  }

  async function replaceVideoFromAuthorPanel(video, panel, neighbors = {}) {
    const videoId = String(video?.id || "").trim();
    if (!videoId || !panel?.isConnected) return;

    const requestId = nextAuthorPanelVideoRequestId();
    panel.setAttribute("aria-busy", "true");
    state.shortVideo.current = video;
    state.shortVideo.loading = false;
    state.shortVideo.status = "";
    state.shortVideo.slideDirection = 0;
    state.shortVideo.prevVideo = neighbors.previous || null;
    state.shortVideo.nextVideo = neighbors.next || null;
    state.shortVideo.prevId = neighbors.previous?.id || "";
    state.shortVideo.nextId = neighbors.next?.id || "";

    replaceCurrentReelDom(video, { transition: true });
    syncAuthorPanelCurrentTile();
    syncRelatedPanelCurrentItem(panel);
    syncCurrentNavigationDom();
    replaceRoute({ view: "shortVideos", shortVideoId: videoId });
    resumeActiveSound();

    try {
      const data = await fetchShortVideoDetail(videoId);
      if (requestId !== currentAuthorPanelVideoRequestId() || state.shortVideo.current?.id !== videoId || !panel.isConnected) return;
      state.shortVideo.current = data.video || video;
      cacheAuthorPanelVideo(state.shortVideo.current);
      const currentPanel = els.workGrid?.querySelector?.(".short-video-reel-panel.is-current");
      const needsGallerySoundRefresh = isGalleryPost(state.shortVideo.current)
        && state.shortVideo.current?.sound?.localAvailable
        && state.shortVideo.current?.sound?.previewUrl
        && !currentPanel?.querySelector?.(".short-video-gallery-audio");
      if (needsGallerySoundRefresh) replaceCurrentReelDom(state.shortVideo.current);
      state.shortVideo.prevId = data.prevId || "";
      state.shortVideo.nextId = data.nextId || "";
      await loadAdjacentVideos(videoId);
      if (requestId !== currentAuthorPanelVideoRequestId() || state.shortVideo.current?.id !== videoId || !panel.isConnected) return;
      refreshAdjacentPanelsDom();
      syncAuthorPanelCurrentTile();
      syncRelatedPanelCurrentItem(panel);
      syncCurrentNavigationDom();
      resumeActiveSound();
    } catch (error) {
      console.warn(error);
      if (requestId === currentAuthorPanelVideoRequestId() && panel.isConnected) {
        showBrowserToast("已切换视频，详情仍在后台读取");
      }
    } finally {
      if (requestId === currentAuthorPanelVideoRequestId() && panel.isConnected) {
        panel.removeAttribute("aria-busy");
      }
    }
  }

  function replaceCurrentReelDom(video, options = {}) {
    const stack = activeReelStack();
    if (!stack) return;
    const oldCurrent = stack.querySelector(".short-video-reel-panel.is-current");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const animateTransition = Boolean(options.transition && oldCurrent && !reducedMotion);
    let outgoing = null;
    if (animateTransition && oldCurrent.classList.contains("is-gallery-post")) {
      outgoing = oldCurrent.cloneNode(true);
      outgoing.classList.remove("is-current", "is-prev", "is-next", "is-ghost-panel");
      outgoing.classList.add("is-transition-outgoing");
      setReelPanelInteractionState(outgoing, false);
      outgoing.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
      outgoing.querySelectorAll("audio, video").forEach((element) => element.remove());
      outgoing.querySelectorAll("button, input, a").forEach((element) => {
        element.setAttribute("tabindex", "-1");
        element.setAttribute("aria-hidden", "true");
      });
    }
    disposeShortVideoMedia(stack);
    stack.querySelectorAll(".short-video-reel-panel.is-transition-outgoing").forEach((panel) => panel.remove());
    if (stack._shortVideoDirectTransitionTimer) window.clearTimeout(stack._shortVideoDirectTransitionTimer);
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev", "is-rebasing");
    stack.style.setProperty("--short-video-drag-y", "0px");

    const panels = [];
    if (state.shortVideo.prevVideo) {
      panels.push(renderReelPanel(state.shortVideo.prevVideo, { ghost: true, slot: "prev" }).panel);
    }
    const current = renderReelPanel(video, { slot: "current" });
    if (animateTransition) current.panel.classList.add("is-transition-incoming");
    panels.push(current.panel);
    if (state.shortVideo.nextVideo) {
      panels.push(renderReelPanel(state.shortVideo.nextVideo, { ghost: true, slot: "next" }).panel);
    }
    stack.replaceChildren(...panels);
    if (outgoing) stack.append(outgoing);
    if (animateTransition) {
      let transitionFinished = false;
      const finishTransition = () => {
        if (transitionFinished) return;
        transitionFinished = true;
        window.clearTimeout(stack._shortVideoDirectTransitionTimer);
        stack._shortVideoDirectTransitionTimer = 0;
        current.panel.removeEventListener("animationend", handleTransitionEnd);
        current.panel.classList.remove("is-transition-incoming");
        outgoing?.remove();
        stack.classList.remove("is-direct-switching");
      };
      const handleTransitionEnd = (event) => {
        if (event.target === current.panel) finishTransition();
      };
      stack.classList.add("is-direct-switching");
      current.panel.addEventListener("animationend", handleTransitionEnd);
      stack._shortVideoDirectTransitionTimer = window.setTimeout(finishTransition, 420);
    }
    current.syncPlayToggle();
    if (current.player) {
      window.requestAnimationFrame(() => {
        current.player?.play?.().then(current.syncPlayToggle).catch(current.syncPlayToggle);
      });
    }
  }


  return showAuthorPanel;
}
