export function createShortVideoListCards(dependencies) {
  const {
    applyShortVideoLikeBadgeState,
    authorScopeId,
    cardTitle,
    coverEagerCount,
    createIcon,
    ensureShortVideoViewerStyles,
    formatDate,
    formatDuration,
    formatNumber,
    formatSeconds,
    formatShortVideoMetric,
    galleryBadge,
    galleryLabel,
    initials,
    isGalleryPost,
    isShortVideoAuthorDetailPage,
    openShortVideoAuthorPage,
    openVideo,
    prewarmShortVideoPlayback,
    rememberShortVideo,
    shortVideoAuthorHandle,
    shortVideoCardCoverUrl,
    shortVideoDeleteSelection,
    showError,
    state,
    toggleShortVideoSelected
  } = dependencies;


  function renderAuthorIndexCard(author = {}) {
    const card = document.createElement("article");
    card.className = "short-video-author-index-card";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-author-index-card-main";
    button.setAttribute("aria-label", `查看 ${author.name || "未知作者"} 的短视频`);
    const media = document.createElement("span");
    media.className = "short-video-author-index-media";
    const imageUrl = author.avatarUrl || author.fallbackCoverUrl || "";
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = imageUrl;
      img.alt = author.name || "作者头像";
      img.loading = "lazy";
      img.decoding = "async";
      media.append(img);
    } else {
      media.classList.add("is-fallback");
      media.textContent = initials(author.name || "?");
    }
    const name = document.createElement("strong");
    name.textContent = author.name || "未知作者";
    const meta = document.createElement("span");
    meta.className = "short-video-author-index-meta";
    meta.textContent = state.shortVideo.source === "following"
      ? `视频 ${formatNumber(author.count || 0)} · 我喜欢 ${formatNumber(author.likedCount || 0)}`
      : `${formatNumber(author.count || 0)} 条视频`;
    button.append(media, name, meta);
    if (author.following) {
      const following = document.createElement("span");
      following.className = "short-video-author-index-following";
      following.textContent = "已关注";
      button.append(following);
    }
    if (author.accountStatus === "banned") {
      const banned = document.createElement("span");
      banned.className = "short-video-author-index-banned";
      banned.textContent = "已封禁";
      banned.title = author.accountStatusReason || "抖音账号已封禁";
      button.append(banned);
    }
    button.addEventListener("click", () => {
      openShortVideoAuthorPage(author);
    });
    card.append(button);
    return card;
  }


  function renderSearchUserCard(author = {}) {
    const card = document.createElement("article");
    card.className = "short-video-search-user-card";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-search-user-card-main";
    button.setAttribute("aria-label", `查看用户 ${author.name || "未知作者"}`);

    const avatar = document.createElement("span");
    avatar.className = "short-video-search-user-avatar";
    const imageUrl = author.avatarUrl || author.fallbackCoverUrl || "";
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = imageUrl;
      img.alt = author.name || "用户头像";
      img.loading = "lazy";
      img.decoding = "async";
      avatar.append(img);
    } else {
      avatar.classList.add("is-fallback");
      avatar.textContent = initials(author.name || "?");
    }

    const content = document.createElement("span");
    content.className = "short-video-search-user-content";
    const nameRow = document.createElement("span");
    nameRow.className = "short-video-search-user-name-row";
    const name = document.createElement("strong");
    name.textContent = author.name || "未知作者";
    nameRow.append(name);
    if (author.following) {
      const following = document.createElement("span");
      following.className = "short-video-search-user-following";
      following.textContent = "已关注";
      nameRow.append(following);
    }
    if (author.accountStatus === "banned") {
      const banned = document.createElement("span");
      banned.className = "short-video-search-user-banned";
      banned.textContent = "已封禁";
      banned.title = author.accountStatusReason || "抖音账号已封禁";
      nameRow.append(banned);
    }
    const handle = document.createElement("span");
    handle.className = "short-video-search-user-handle";
    handle.textContent = author.uniqueId
      ? `抖音号：${author.uniqueId}`
      : shortVideoAuthorHandle(author.name || "未知作者");
    const meta = document.createElement("span");
    meta.className = "short-video-search-user-meta";
    meta.textContent = `${formatNumber(author.count || 0)} 条本地作品`;
    content.append(nameRow, handle, meta);

    const action = document.createElement("span");
    action.className = "short-video-search-user-action";
    action.textContent = "查看主页";
    button.append(avatar, content, action);
    button.addEventListener("click", () => openShortVideoAuthorPage(author));
    card.append(button);
    return card;
  }


  function renderVideoCard(video, index = 0) {
    const card = document.createElement("article");
    card.className = "short-video-card";
    card.dataset.videoId = String(video?.id || "");
    card.shortVideoCardRecord = video;
    const authorWork = isShortVideoAuthorDetailPage();
    card.classList.toggle("is-author-work", authorWork);
    const selection = shortVideoDeleteSelection();
    const selected = selection.has(String(video.id || ""));
    const selecting = Boolean(state.shortVideo.deleteMode);
    card.classList.toggle("is-selecting", selecting);
    card.classList.toggle("is-selected", selected);
    const thumb = document.createElement("div");
    thumb.className = "short-video-thumb";
    const coverUrl = shortVideoCardCoverUrl(video);
    if (!coverUrl) return null;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "short-video-thumb-open";
    open.setAttribute("aria-label", selecting ? `选择 ${video.title || "短视频"}` : video.title || "打开短视频");
    if (selecting) open.setAttribute("aria-pressed", String(selected));
    const img = document.createElement("img");
    img.className = "short-video-cover-image";
    img.dataset.src = coverUrl;
    img.dataset.videoId = video.id;
    img.alt = video.title || "短视频封面";
    img.loading = index < coverEagerCount ? "eager" : "lazy";
    img.decoding = "async";
    img.fetchPriority = index < 8 ? "high" : "low";
    open.append(img);
    if (video.deletedFromAuthor) {
      const deleted = document.createElement("span");
      deleted.className = "short-video-deleted-badge";
      deleted.textContent = "主页已删除";
      open.append(deleted);
    }
    const like = document.createElement("span");
    like.className = "short-video-like-badge";
    like.append(createIcon("heart"), document.createTextNode(formatShortVideoMetric(video, "likes")));
    applyShortVideoLikeBadgeState(like, video);
    if (!selecting && video.actions?.liked) {
      open.setAttribute("aria-label", `${video.title || "打开短视频"}，已点赞`);
    }
    open.append(like);
    if (isGalleryPost(video)) {
      open.append(galleryBadge(video));
    } else if (!authorWork) {
      const durationText = formatDuration(video.durationMs);
      if (durationText) {
        const duration = document.createElement("span");
        duration.className = "short-video-duration-badge";
        duration.textContent = durationText;
        open.append(duration);
      }
    }
    appendShortVideoWatchBadge(open, video);
    const selectionBadge = document.createElement("span");
    selectionBadge.className = "short-video-selection-badge";
    selectionBadge.append(createIcon("check"));
    open.append(selectionBadge);
    const prewarmPlayback = () => {
      if (state.shortVideo.deleteMode || isGalleryPost(video)) return;
      Promise.resolve(ensureShortVideoViewerStyles?.()).catch(() => {});
      rememberShortVideo(video);
      prewarmShortVideoPlayback(video).catch(() => {});
    };
    open.addEventListener("pointerenter", prewarmPlayback, { passive: true });
    open.addEventListener("pointerdown", prewarmPlayback, { passive: true });
    open.addEventListener("focus", prewarmPlayback);
    open.addEventListener("click", () => {
      if (state.shortVideo.deleteMode) {
        toggleShortVideoSelected(video.id);
        return;
      }
      openVideo(video.id, { video }).catch(showError);
    });
    thumb.append(open);
    const title = document.createElement("div");
    title.className = "short-video-card-title";
    title.textContent = cardTitle(video);
    card.append(thumb, title);
    if (authorWork) {
      const meta = document.createElement("div");
      meta.className = "short-video-card-meta";
      const date = document.createElement("span");
      date.textContent = formatDate(video.publishedAt) || "日期未知";
      const duration = document.createElement("span");
      duration.textContent = isGalleryPost(video) ? galleryLabel(video) : (formatDuration(video.durationMs) || "-");
      const comments = document.createElement("span");
      comments.append(createIcon("comment"), document.createTextNode(formatShortVideoMetric(video, "comments")));
      meta.append(date, duration, comments);
      card.append(meta);
    } else {
      const subline = document.createElement("div");
      subline.className = "short-video-card-subline";
      const authorName = String(video.author?.name || "未知作者").trim() || "未知作者";
      if (authorScopeId(video, video.author)) {
        const author = document.createElement("button");
        author.type = "button";
        author.className = "short-video-card-author";
        author.textContent = shortVideoAuthorHandle(authorName);
        author.title = `查看 ${authorName}`;
        author.disabled = selecting;
        author.addEventListener("click", () => openShortVideoAuthorPage(video.author, video));
        subline.append(author);
      } else {
        const author = document.createElement("span");
        author.className = "short-video-card-author is-static";
        author.textContent = shortVideoAuthorHandle(authorName);
        subline.append(author);
      }
      if (state.shortVideo.source === "recommended" && video.recommendation?.reason) {
        const reason = document.createElement("span");
        reason.className = "short-video-recommend-reason";
        reason.textContent = video.recommendation.reason;
        subline.append(reason);
      }
      const date = document.createElement("span");
      date.className = "short-video-card-date";
      date.textContent = formatDate(video.publishedAt) || "日期未知";
      subline.append(date);
      card.append(subline);
    }
    return card;
  }

  function appendShortVideoWatchBadge(target, video = {}) {
    const watchedAt = String(video?.watch?.lastWatchedAt || "").trim();
    if (!watchedAt) return;
    const completed = Boolean(video?.watch?.completed);
    const progressMs = Math.max(0, Number(video?.watch?.progressMs || 0));
    const durationMs = Math.max(0, Number(video?.durationMs || 0));
    const ratio = completed
      ? 1
      : (durationMs > 0 ? Math.max(0, Math.min(1, progressMs / durationMs)) : 0);
    const badge = document.createElement("span");
    badge.className = "short-video-watch-badge";
    badge.textContent = completed
      ? "已看完"
      : (progressMs >= 1000 ? `续播 ${formatSeconds(progressMs / 1000)}` : "看过");
    const track = document.createElement("span");
    track.className = "short-video-watch-progress";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(3, Math.round(ratio * 100))}%`;
    track.append(fill);
    target.append(badge, track);
  }


  return { renderAuthorIndexCard, renderSearchUserCard, renderVideoCard };
}
