import {
  authorIndexReturnState,
  canReturnThroughShortVideoHistory,
  captureAuthorIndexReturnContext
} from "./author-navigation.js?v=20260811-author-route-lifecycle-01";
import { createAuthorCollectorPoll } from "./author-collector-poll.js?v=20260811-author-route-lifecycle-01";

export function createShortVideoAuthorPages(deps) {
  const {
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
    getShortVideoListCards,
    loadVideos,
    openAuthorDouyinLink,
    profileNumber,
    pushRoute,
    renderDeleteSelectionActions,
    replaceRoute,
    setAuthorPanelReturnFeed,
    shortVideoAuthorMentionCache,
    shortVideoCardCoverUrl,
    shortVideoSearch,
    showBrowserToast,
    showError,
    state
  } = deps;
  let authorIndexReturnContext = captureAuthorIndexReturnContext(state.shortVideo);
  let authorPageEnteredWithinApp = false;
  const {
    cancel: cancelAuthorCollectorPolling,
    isCurrent: isCurrentAuthorPage,
    sync: syncAuthorCollectorRouteLifecycle,
    wait: waitForAuthorCollector
  } = createAuthorCollectorPoll({ api, isCurrentAuthorPage: isAuthorPageActive });

  window.addEventListener("pagehide", () => cancelAuthorCollectorPolling(), { passive: true });

  function renderAuthorDetailHome(data = {}) {
    const author = currentShortVideoAuthorDetail(data);
    const visibleAuthorVideo = (data.videos || []).find((video) => video?.ownerUserId || video?.author?.id) || null;
    if (visibleAuthorVideo) state.shortVideo.authorVideo = visibleAuthorVideo;
    const authorVideo = visibleAuthorVideo || state.shortVideo.authorVideo || null;
    const head = document.createElement("section");
    head.className = "short-video-author-page-head";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "short-video-author-page-back";
    back.setAttribute("aria-label", "返回作者列表");
    back.append(createIcon("chevronLeft"), document.createTextNode("返回作者列表"));
    back.addEventListener("click", returnToShortVideoAuthorIndex);
    head.append(back);
    const heroCoverUrl = shortVideoCardCoverUrl(authorVideo || {});
    if (heroCoverUrl) {
      const hero = document.createElement("div");
      hero.className = "short-video-author-page-hero";
      hero.setAttribute("aria-hidden", "true");
      const heroImage = document.createElement("img");
      heroImage.src = heroCoverUrl;
      heroImage.alt = "";
      heroImage.loading = "eager";
      heroImage.decoding = "async";
      hero.append(heroImage);
      head.append(hero);
    }
    const avatar = authorAvatar(author, "short-video-author-page-avatar");
    const copy = document.createElement("div");
    copy.className = "short-video-author-page-copy";
    const eyebrow = document.createElement("span");
    eyebrow.className = "short-video-author-page-eyebrow";
    eyebrow.textContent = "抖音作者";
    const nameRow = document.createElement("div");
    nameRow.className = "short-video-author-page-name-row";
    const name = document.createElement("strong");
    name.textContent = author.name || authorNameFromFilter(state.shortVideo.author) || "未知作者";
    nameRow.append(name);
    if (author.accountStatus === "banned") {
      const banned = document.createElement("span");
      banned.className = "short-video-author-page-banned";
      banned.textContent = "已封禁";
      banned.title = author.accountStatusReason || "抖音账号已封禁";
      nameRow.append(banned);
    }
    const verification = String(author.verification || "").trim();
    if (verification) {
      const badge = document.createElement("span");
      badge.className = "short-video-author-page-verified";
      badge.textContent = verification;
      nameRow.append(badge);
    }
    const identity = document.createElement("div");
    identity.className = "short-video-author-page-identity";
    const identityText = authorProfileLineText({ ...author, verification: "" });
    identity.textContent = identityText || "本地作者资料";
    const signature = document.createElement("p");
    signature.className = "short-video-author-page-signature";
    renderAuthorSignature(signature, author.signature, "暂无作者简介");
    const stats = document.createElement("div");
    stats.className = "short-video-author-page-stats";
    for (const [label, value] of [
      ["关注", profileNumber(author.followingCount)],
      ["粉丝", profileNumber(author.followerCount)],
      ["获赞", profileNumber(author.totalFavorited)],
      ["作品", profileNumber(author.awemeCount)],
      ["喜欢", profileNumber(author.favoritingCount)]
    ]) {
      if (value === null) continue;
      const cell = document.createElement("span");
      const strong = document.createElement("b");
      strong.textContent = formatCompact(value);
      const small = document.createElement("small");
      small.textContent = label;
      cell.append(strong, small);
      stats.append(cell);
    }
    const libraryMeta = document.createElement("div");
    libraryMeta.className = "short-video-author-page-library-meta";
    const localTotal = Math.max(0, Number(author.count || data.total || 0));
    const localCount = document.createElement("b");
    localCount.textContent = `${formatNumber(localTotal)} 个本地作品`;
    libraryMeta.append(localCount);
    const homeCount = profileNumber(author.awemeCount);
    if (homeCount !== null) {
      const comparison = document.createElement("span");
      comparison.textContent = `主页 ${formatNumber(homeCount)}`;
      libraryMeta.append(comparison);
    }
    const deletedTotal = Math.max(0, Number(data.deletedTotal || 0));
    if (deletedTotal) {
      const deleted = document.createElement("span");
      deleted.className = "short-video-author-page-deleted";
      deleted.textContent = `主页已删除 ${formatNumber(deletedTotal)}`;
      libraryMeta.append(deleted);
    } else if (homeCount !== null && localTotal > homeCount) {
      const pendingDifference = document.createElement("span");
      pendingDifference.className = "short-video-author-page-pending-difference";
      pendingDifference.textContent = `待确认差 ${formatNumber(localTotal - homeCount)}`;
      pendingDifference.title = "本地作品数多于主页作品数，可点击“确认数量”执行一次完整主页扫描";
      libraryMeta.append(pendingDifference);
    }
    const collectedAt = formatDate(author.profileCollectedAt);
    if (collectedAt) {
      const collected = document.createElement("span");
      collected.textContent = `资料更新 ${collectedAt}`;
      libraryMeta.append(collected);
    }
    copy.append(eyebrow, nameRow, stats, identity, signature, libraryMeta);
    const actions = document.createElement("div");
    actions.className = "short-video-author-page-actions";
    const follow = createAuthorFollowButton(authorVideo, author, "page");
    const douyin = document.createElement("button");
    douyin.type = "button";
    douyin.className = "short-video-author-page-secondary";
    douyin.textContent = "抖音主页";
    douyin.addEventListener("click", () => openAuthorDouyinLink(author));
    const quickRefresh = document.createElement("button");
    quickRefresh.type = "button";
    quickRefresh.className = "short-video-author-page-secondary short-video-author-collector-action";
    quickRefresh.textContent = "快速刷新";
    quickRefresh.title = "通过 8765 增量采集最新作品，连续遇到旧作品后快速停止";
    quickRefresh.hidden = author.accountStatus === "banned";
    quickRefresh.addEventListener("click", () => runAuthorCollector(author, "quick", quickRefresh)
      .catch((error) => showBrowserToast(error?.message || "快速刷新启动失败")));
    const fullRefresh = document.createElement("button");
    fullRefresh.type = "button";
    fullRefresh.className = "short-video-author-page-secondary short-video-author-collector-action short-video-author-confirm-action";
    fullRefresh.textContent = "确认数量";
    fullRefresh.title = "完整扫描当前作者主页，确认主页作品数与本地作品数的差异";
    if (author.accountStatus === "banned") {
      fullRefresh.textContent = "手动确认";
      fullRefresh.title = "手动重新检查该主页；账号恢复且能读取到作品时会解除封禁状态";
    }
    fullRefresh.addEventListener("click", () => runAuthorCollector(author, "full", fullRefresh)
      .catch((error) => showBrowserToast(error?.message || "数量确认启动失败")));
    actions.append(follow, douyin, quickRefresh, fullRefresh);
    head.append(avatar, copy, actions);
    return head;
  }

  async function runAuthorCollector(author = {}, mode = "quick", button) {
    const secUid = String(author?.secUid || state.shortVideo.author || "").trim();
    if (!secUid || secUid.startsWith("name:")) {
      showBrowserToast("当前作者没有可关联的抖音 sec_uid");
      return;
    }
    const actions = button?.closest(".short-video-author-page-actions");
    const buttons = [...(actions?.querySelectorAll(".short-video-author-collector-action") || [])];
    const originalText = button?.textContent || (mode === "full" ? "确认数量" : "快速刷新");
    buttons.forEach((item) => { item.disabled = true; });
    button?.setAttribute("aria-busy", "true");
    if (button) button.textContent = mode === "full" ? "开始确认" : "启动刷新";
    try {
      const result = await api(`/api/short-videos/authors/${encodeURIComponent(secUid)}/collector`, {
        method: "POST",
        body: { mode }
      });
      const jobId = Number(result?.jobId || 0);
      if (!jobId) throw new Error("8765 没有返回采集任务编号");
      showBrowserToast(mode === "full" ? `数量确认已启动 #${jobId}` : `快速刷新已启动 #${jobId}`);
      if (!isCurrentAuthorPage(secUid)) return;
      const finalState = await waitForAuthorCollector({
        authorId: secUid,
        jobId,
        onProgress: ({ processed, total }) => {
          if (button?.isConnected) button.textContent = total ? `采集中 ${processed}/${total}` : "采集中";
        }
      });
      if (!finalState || !isCurrentAuthorPage(secUid)) return;
      if (finalState?.job?.status === "failed") throw new Error(finalState.job.message || "作者主页采集失败");
      if (finalState?.job?.status === "stopped") throw new Error(finalState.job.message || "作者主页采集已停止");
      showBrowserToast(finalState?.job?.message || (mode === "full" ? "数量确认完成" : "快速刷新完成"));
      if (isCurrentAuthorPage(secUid)) await loadVideos({ skipRoute: true });
    } finally {
      buttons.forEach((item) => { item.disabled = false; });
      button?.removeAttribute("aria-busy");
      if (button?.isConnected) button.textContent = originalText;
    }
  }

  function isAuthorPageActive(authorId) {
    return state.activeView === "shortVideos"
      && !state.shortVideo?.current
      && String(state.shortVideo?.authorPage || "").trim() === String(authorId || "").trim();
  }

  function renderAuthorWorkspaceToolbar(data = {}) {
    const section = document.createElement("section");
    section.className = "short-video-author-workspace";
    const heading = document.createElement("div");
    heading.className = "short-video-author-workspace-heading";
    heading.setAttribute("role", "tablist");
    heading.setAttribute("aria-label", "作者作品来源");
    const author = currentShortVideoAuthorDetail(data);
    const authorTotal = author.count || data.total || 0;
    const activeSource = ["all", "posts", "liked", "local"].includes(state.shortVideo.source)
      ? state.shortVideo.source
      : "all";
    for (const [value, label] of [
      ["all", "作品"],
      ["posts", "发布"],
      ["liked", "喜欢"],
      ["local", "本地"]
    ]) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "short-video-author-workspace-tab";
      tab.classList.toggle("active", activeSource === value);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(activeSource === value));
      tab.append(document.createTextNode(label));
      if (value === "all") {
        const count = document.createElement("small");
        count.textContent = state.shortVideo.loading ? "…" : formatNumber(authorTotal);
        tab.append(count);
      } else if (value === "liked") {
        tab.append(createIcon("eyeOff"));
      }
      tab.addEventListener("click", () => {
        if (value === state.shortVideo.source) return;
        state.shortVideo.source = value;
        state.shortVideo.data = null;
        clearShortVideoDeleteSelection();
        loadVideos({ replaceRoute: true }).catch(showError);
      });
      heading.append(tab);
    }

    const filters = document.createElement("div");
    filters.className = "short-video-author-filters";
    const search = shortVideoSearch.renderForm({
      compact: true,
      placeholder: "搜索 TA 的作品",
      ariaLabel: "搜索作者作品",
      params: () => ({ author: state.shortVideo.authorPage || state.shortVideo.author })
    });
    filters.append(search, renderDeleteSelectionActions(data));
    section.append(heading, filters);
    return section;
  }

  function openShortVideoAuthorPage(author = {}, video = {}, options = {}) {
    const authorId = authorScopeId(video, author);
    if (!authorId) {
      showBrowserToast("没有作者资料");
      return;
    }
    setAuthorPanelReturnFeed(null);
    if (isShortVideoAuthorIndexPage()) {
      state.shortVideo.authorIndexSource = state.shortVideo.source;
      authorIndexReturnContext = captureAuthorIndexReturnContext(state.shortVideo);
    }
    authorPageEnteredWithinApp = !options.replaceHistory;
    syncAuthorCollectorRouteLifecycle(authorId);
    state.shortVideo.authorPage = authorId;
    state.shortVideo.author = authorId;
    state.shortVideo.authorDetail = { ...(video?.author || {}), ...author, secUid: authorId };
    state.shortVideo.authorVideo = video?.id ? video : null;
    state.shortVideo.source = "all";
    state.shortVideo.query = "";
    state.shortVideo.topic = "";
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    state.shortVideo.media = "all";
    state.shortVideo.quality = "all";
    state.shortVideo.deleted = "all";
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();
    const updateRoute = options.replaceHistory ? replaceRoute : pushRoute;
    updateRoute({
      view: "shortVideos",
      shortVideoId: "",
      shortVideoAuthorPage: authorId,
      shortVideoAuthor: authorId,
      shortVideoQuery: "",
      shortVideoSource: "all"
    });
    loadVideos({ skipRoute: true }).catch(showError);
  }

  function returnToShortVideoAuthorIndex() {
    cancelAuthorCollectorPolling();
    if (canReturnThroughShortVideoHistory({
      enteredWithinApp: authorPageEnteredWithinApp,
      referrer: document.referrer,
      currentHref: window.location.href
    }) && window.history.length > 1) {
      window.history.back();
      return;
    }
    const target = authorIndexReturnState(authorIndexReturnContext);
    Object.assign(state.shortVideo, target, {
      author: "all",
      authorPage: "",
      current: null,
      data: null,
      prevId: "",
      nextId: "",
      prevVideo: null,
      nextVideo: null,
      topic: "",
      sound: "",
      soundInfo: null,
      media: "all",
      quality: "all",
      deleted: "all"
    });
    clearShortVideoDeleteSelection();
    replaceRoute({
      view: "shortVideos",
      shortVideoId: "",
      shortVideoAuthorPage: "",
      shortVideoAuthor: "all",
      shortVideoQuery: target.query,
      shortVideoSource: target.source,
      shortVideoSort: target.sort,
      shortVideoAuthorAccountStatus: target.authorAccountStatus
    });
    loadVideos({ skipRoute: true }).catch(showError);
  }

  function renderAuthorSignature(target, value, fallback = "") {
    const text = String(value || fallback || "").trim();
    target.textContent = "";
    if (!text) return;
    const mentionPattern = /@([^\s@，。！？、；：,.!?;:()\[\]{}<>《》【】"'“”‘’]+)/gu;
    let cursor = 0;
    let match = mentionPattern.exec(text);
    while (match) {
      if (match.index > cursor) target.append(document.createTextNode(text.slice(cursor, match.index)));
      const mention = match[1];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-author-mention";
      button.textContent = `@${mention}`;
      button.title = `打开 ${mention} 的作者主页`;
      button.addEventListener("click", () => openMentionedAuthor(mention, button));
      target.append(button);
      cursor = match.index + match[0].length;
      match = mentionPattern.exec(text);
    }
    if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
  }

  async function openMentionedAuthor(mention, button) {
    if (button?.getAttribute("aria-busy") === "true") return;
    button?.setAttribute("aria-busy", "true");
    try {
      const author = await resolveShortVideoAuthor(mention);
      if (!author?.secUid) {
        showBrowserToast(`本地没有找到 @${mention}`);
        return;
      }
      openShortVideoAuthorPage(author);
    } catch (error) {
      showBrowserToast(error?.message || `无法打开 @${mention}`);
    } finally {
      button?.removeAttribute("aria-busy");
    }
  }

  async function resolveShortVideoAuthor(value) {
    const cacheKey = String(value || "").trim().replace(/^@+\s*/u, "").toLocaleLowerCase("zh-CN");
    if (!cacheKey) return null;
    const cached = shortVideoAuthorMentionCache.get(cacheKey);
    if (cached) {
      cacheShortVideoAuthorMention(cacheKey, cached);
      return cached;
    }
    const data = await api(`/api/short-videos/authors/resolve?mention=${encodeURIComponent(value)}`);
    const author = data?.author || null;
    if (!author) return null;
    for (const key of [author.name, author.secUid, author.uniqueId, author.shortId]) {
      const normalizedKey = String(key || "").trim().toLocaleLowerCase("zh-CN");
      if (normalizedKey) cacheShortVideoAuthorMention(normalizedKey, author);
    }
    cacheShortVideoAuthorMention(cacheKey, author);
    return author;
  }

  function renderAuthorIndex() {
    const authors = sortedShortVideoAuthors();
    const wrap = document.createElement("div");
    wrap.className = "short-video-author-index";
    if (state.shortVideo.loading && !authors.length) {
      const status = document.createElement("div");
      status.className = "short-video-author-index-status";
      status.textContent = "正在读取作者";
      wrap.append(status);
      return wrap;
    }
    if (!authors.length) {
      const status = document.createElement("div");
      status.className = "short-video-author-index-status";
      status.textContent = state.shortVideo.source === "following"
        ? state.shortVideo.authorFilter === "unliked"
          ? "没有未点赞的关注账号"
          : "还没有已关注的作者"
        : state.shortVideo.authorAccountStatus === "banned"
          ? "没有已封禁的作者"
          : "还没有作者数据";
      wrap.append(status);
      return wrap;
    }
    for (const author of authors) {
      wrap.append(renderAuthorIndexCard(author));
    }
    if (state.shortVideo.authorHasMore || state.shortVideo.authorLoadingMore) {
      const status = document.createElement("div");
      status.className = "short-video-author-index-status short-video-author-index-more";
      status.textContent = state.shortVideo.authorLoadingMore ? "正在加载更多作者" : "继续下滑加载更多作者";
      wrap.append(status);
    }
    return wrap;
  }

  function sortedShortVideoAuthors() {
    const authors = [...(state.shortVideo.authors || [])]
      .filter((author) => author && (author.secUid || author.name));
    if (state.shortVideo.source === "following") return authors;
    return authors.sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
  }

  function appendVisibleAuthorsIfNeeded(force = false) {
    if (state.activeView !== "shortVideos" || state.shortVideo?.current || !isShortVideoAuthorIndexPage()) return;
    if (!state.shortVideo.authorHasMore || state.shortVideo.loading || state.shortVideo.authorLoadingMore) return;
    if (!force) {
      const doc = document.documentElement;
      const bottomDistance = Math.max(0, (doc.scrollHeight || 0) - ((window.scrollY || 0) + (window.innerHeight || 0)));
      if (bottomDistance > AUTHOR_APPEND_LOOKAHEAD) return;
    }
    loadVideos({ append: true, skipRoute: true }).catch(showError);
  }

  function isShortVideoAuthorIndexPage() {
    return !state.shortVideo?.authorPage && ["authors", "following"].includes(state.shortVideo?.source);
  }

  function isShortVideoAuthorDetailPage() {
    return Boolean(state.shortVideo?.authorPage);
  }

  function shortVideoApiSource() {
    if (isShortVideoAuthorDetailPage()) {
      return ["liked", "posts", "all", "local"].includes(state.shortVideo.source) ? state.shortVideo.source : "all";
    }
    return state.shortVideo.source || "liked";
  }

  function currentShortVideoAuthorDetail(data = {}) {
    const filter = String(state.shortVideo.author || "").trim();
    const fromVideo = (data.videos || []).find((video) => video?.author)?.author || {};
    const fromFacet = (state.shortVideo.authors || []).find((author) => shortVideoAuthorFilterValue(author) === filter) || {};
    const cached = state.shortVideo.authorDetail || {};
    const fromCache = shortVideoAuthorFilterValue(cached) === filter ? cached : {};
    const fresh = { ...fromVideo, ...fromFacet };
    const preserveCachedProfile = Boolean(fromCache.secUid || fromCache.name) && state.shortVideo.source !== "all";
    const detail = preserveCachedProfile
      ? { ...fresh, ...fromCache }
      : { ...fromCache, ...fresh };
    detail.name = preserveCachedProfile
      ? (fromCache.name || fromFacet.name || fromVideo.name || authorNameFromFilter(filter))
      : (fromFacet.name || fromVideo.name || fromCache.name || authorNameFromFilter(filter));
    if (state.shortVideo.source === "all" && Number.isFinite(Number(data.total))) {
      detail.count = Math.max(0, Number(data.total));
    }
    if (detail.secUid || detail.name) {
      state.shortVideo.authorDetail = { ...detail };
    }
    return detail;
  }

  function shortVideoAuthorFilterValue(author = {}) {
    const secUid = String(author.secUid || "").trim();
    if (secUid) return secUid;
    const name = String(author.name || "").trim();
    return name ? `name:${name}` : "all";
  }

  function authorNameFromFilter(value) {
    const text = String(value || "").trim();
    return text.startsWith("name:") ? text.slice(5) : "";
  }

  function shortVideoAuthorDisplayName(value, fallback = "未知作者") {
    const name = String(value || "").trim().replace(/^(?:@\s*)+/u, "").trim();
    return name || fallback;
  }

  function shortVideoAuthorHandle(value, fallback = "未知作者") {
    return `@${shortVideoAuthorDisplayName(value, fallback)}`;
  }

  function renderAuthorIndexCard(author = {}) {
    return getShortVideoListCards()?.renderAuthorIndexCard(author) || null;
  }

  function renderSearchUserCard(author = {}) {
    return getShortVideoListCards()?.renderSearchUserCard(author) || null;
  }


  return {
    appendVisibleAuthorsIfNeeded,
    authorNameFromFilter,
    currentShortVideoAuthorDetail,
    isShortVideoAuthorDetailPage,
    isShortVideoAuthorIndexPage,
    cancelAuthorCollectorPolling,
    openShortVideoAuthorPage,
    renderAuthorDetailHome,
    renderAuthorIndex,
    renderAuthorIndexCard,
    renderAuthorSignature,
    renderAuthorWorkspaceToolbar,
    renderSearchUserCard,
    resolveShortVideoAuthor,
    shortVideoApiSource,
    shortVideoAuthorDisplayName,
    shortVideoAuthorFilterValue,
    shortVideoAuthorHandle,
    syncAuthorCollectorRouteLifecycle
  };
}
