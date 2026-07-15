export function createShortVideoCommentsView(deps) {
  const {
    api,
    copyShortVideoValue,
    createIcon,
    formatCompact,
    formatLocalCommentDate,
    formatNumber,
    localShortVideoUrl,
    openDouyinLink,
    originalDouyinUrl,
    showBrowserToast
  } = deps;

  return function shortVideoCommentsView(video) {
    const commentCount = Math.max(0, Number(video?.stats?.comments || 0));
    const originalUrl = originalDouyinUrl(video);
    const videoId = String(video?.id || "").trim();
    const commentsEndpoint = `/api/short-videos/${encodeURIComponent(videoId)}/comments`;
    const wrap = document.createElement("div");
    wrap.className = "short-video-comments";

    const heading = document.createElement("div");
    heading.className = "short-video-comments-heading";
    const title = document.createElement("strong");
    title.textContent = `${formatCompact(commentCount)} 条评论`;
    const source = document.createElement("span");
    source.textContent = "原视频统计";
    heading.append(title, source);

    const scroll = document.createElement("div");
    scroll.className = "short-video-comments-scroll";

    const localSection = document.createElement("section");
    localSection.className = "short-video-local-comments";
    const localHeading = document.createElement("div");
    localHeading.className = "short-video-local-comments-heading";
    const localTitle = document.createElement("strong");
    localTitle.textContent = "我的本地评论";
    const localCount = document.createElement("span");
    localCount.textContent = "读取中";
    localHeading.append(localTitle, localCount);
    const localList = document.createElement("div");
    localList.className = "short-video-local-comment-list";
    localSection.append(localHeading, localList);

    const remote = document.createElement("section");
    remote.className = "short-video-comments-remote";
    const remoteIcon = document.createElement("span");
    remoteIcon.className = "short-video-comments-remote-icon";
    remoteIcon.append(createIcon("comment"));
    const remoteCopy = document.createElement("div");
    remoteCopy.className = "short-video-comments-remote-copy";
    const remoteTitle = document.createElement("strong");
    remoteTitle.textContent = commentCount
      ? `${formatCompact(commentCount)} 条抖音评论未同步`
      : "原视频暂无评论正文";
    const remoteMessage = document.createElement("p");
    remoteMessage.textContent = commentCount
      ? "这里只显示保存在本机的评论；原评论请前往抖音查看。"
      : "当前资料库没有保存原视频评论正文。";
    const remoteList = document.createElement("div");
    remoteList.className = "short-video-remote-comment-list";
    remoteCopy.append(remoteTitle, remoteMessage, remoteList);

    const actions = document.createElement("div");
    actions.className = "short-video-comments-remote-actions";
    const sync = document.createElement("button");
    sync.type = "button";
    sync.className = "is-primary";
    sync.textContent = "同步评论";
    sync.title = "通过本机 8765 拉取并保存前 100 条抖音评论";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "查看原评论";
    open.disabled = !originalUrl;
    open.title = originalUrl ? "打开抖音原视频" : "当前作品没有原始链接";
    open.addEventListener("click", () => openDouyinLink(video));
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制链接";
    copy.addEventListener("click", () => {
      const value = originalUrl || localShortVideoUrl(video);
      copyShortVideoValue(value, originalUrl ? "已复制抖音原链接" : "已复制本地链接").catch(() => {});
    });
    actions.append(sync, open, copy);
    remote.append(remoteIcon, remoteCopy, actions);

    const note = document.createElement("div");
    note.className = "short-video-comments-note";
    note.append(createIcon("check"), document.createTextNode("“我的本地评论”只保存在这台设备，不会发布到抖音"));

    scroll.append(remote, localSection, note);

    const composer = document.createElement("form");
    composer.className = "short-video-comment-composer";
    const composerAvatar = document.createElement("span");
    composerAvatar.className = "short-video-comment-composer-avatar";
    composerAvatar.textContent = "我";
    const composerField = document.createElement("div");
    composerField.className = "short-video-comment-composer-field";
    const textarea = document.createElement("textarea");
    textarea.rows = 1;
    textarea.maxLength = 500;
    textarea.placeholder = "说点什么，只保存在本机…";
    textarea.setAttribute("aria-label", "输入本地评论");
    const composerFooter = document.createElement("div");
    composerFooter.className = "short-video-comment-composer-footer";
    const composerHint = document.createElement("span");
    composerHint.textContent = "Enter 发送 · Shift+Enter 换行";
    const composerActions = document.createElement("span");
    const characterCount = document.createElement("small");
    characterCount.textContent = "0/500";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "发送";
    submit.disabled = true;
    composerActions.append(characterCount, submit);
    composerFooter.append(composerHint, composerActions);
    composerField.append(textarea, composerFooter);
    composer.append(composerAvatar, composerField);

    let comments = [];
    let remoteComments = [];
    let loading = true;
    let loadError = "";

    const renderRemoteComments = () => {
      remoteList.innerHTML = "";
      remote.classList.toggle("has-comments", remoteComments.length > 0);
      if (!remoteComments.length) {
        remoteTitle.textContent = commentCount
          ? `${formatCompact(commentCount)} 条抖音评论未同步`
          : "原视频暂无评论正文";
        remoteMessage.textContent = commentCount
          ? "点击同步评论，可保存前 100 条到本机。"
          : "当前资料库没有保存原视频评论正文。";
        return;
      }
      remoteTitle.textContent = `已同步 ${formatNumber(remoteComments.length)} 条抖音评论`;
      remoteMessage.textContent = "评论正文已保存在本机；再次同步会更新点赞和回复数量。";
      for (const comment of remoteComments) remoteList.append(renderRemoteComment(comment));
    };

    const renderRemoteComment = (comment = {}) => {
      const item = document.createElement("article");
      item.className = "short-video-local-comment is-remote";
      const avatar = document.createElement("span");
      avatar.className = "short-video-local-comment-avatar";
      const rawAvatarUrl = String(comment.userAvatarUrl || "").trim();
      const avatarUrl = /^https?:\/\//i.test(rawAvatarUrl) ? rawAvatarUrl : "";
      if (avatarUrl) {
        const image = document.createElement("img");
        image.src = avatarUrl;
        image.alt = "";
        image.loading = "lazy";
        avatar.append(image);
      } else {
        avatar.textContent = String(comment.userName || "抖").trim().slice(0, 1) || "抖";
      }
      const body = document.createElement("div");
      body.className = "short-video-local-comment-body";
      const meta = document.createElement("div");
      meta.className = "short-video-local-comment-meta";
      const name = document.createElement("strong");
      name.textContent = comment.userName || "抖音用户";
      const badge = document.createElement("span");
      badge.textContent = "抖音";
      const time = document.createElement("time");
      time.dateTime = comment.createdAt || "";
      time.textContent = formatLocalCommentDate(comment.createdAt);
      meta.append(name, badge, time);
      const content = document.createElement("p");
      content.textContent = comment.body || "";
      const metrics = document.createElement("small");
      metrics.className = "short-video-remote-comment-metrics";
      const parts = [];
      if (comment.ipLabel) parts.push(comment.ipLabel);
      if (Number(comment.likes || 0) > 0) parts.push(`${formatCompact(comment.likes)} 赞`);
      if (Number(comment.replyCount || 0) > 0) parts.push(`${formatCompact(comment.replyCount)} 回复`);
      metrics.textContent = parts.join(" · ");
      body.append(meta, content);
      if (parts.length) body.append(metrics);
      item.append(avatar, body);
      return item;
    };

    const renderLocalComments = () => {
      localList.innerHTML = "";
      localCount.textContent = loading ? "读取中" : `${comments.length} 条`;
      if (loading) {
        const status = document.createElement("div");
        status.className = "short-video-local-comments-status is-loading";
        status.textContent = "正在读取本地评论";
        localList.append(status);
        return;
      }
      if (loadError) {
        const status = document.createElement("div");
        status.className = "short-video-local-comments-status is-error";
        const message = document.createElement("span");
        message.textContent = loadError;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "重试";
        retry.addEventListener("click", () => loadLocalComments());
        status.append(message, retry);
        localList.append(status);
        return;
      }
      if (!comments.length) {
        const empty = document.createElement("div");
        empty.className = "short-video-local-comments-status";
        empty.textContent = "还没有本地评论，写下第一条只给自己看的评论。";
        localList.append(empty);
        return;
      }
      for (const comment of comments) localList.append(renderLocalComment(comment));
    };

    const renderLocalComment = (comment = {}) => {
      const item = document.createElement("article");
      item.className = "short-video-local-comment";
      item.dataset.commentId = comment.id || "";
      const avatar = document.createElement("span");
      avatar.className = "short-video-local-comment-avatar";
      avatar.textContent = "我";
      const body = document.createElement("div");
      body.className = "short-video-local-comment-body";
      const meta = document.createElement("div");
      meta.className = "short-video-local-comment-meta";
      const name = document.createElement("strong");
      name.textContent = "我";
      const badge = document.createElement("span");
      badge.textContent = "本地";
      const time = document.createElement("time");
      time.dateTime = comment.createdAt || "";
      time.textContent = formatLocalCommentDate(comment.createdAt);
      meta.append(name, badge, time);
      const content = document.createElement("p");
      content.textContent = comment.body || "";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "short-video-local-comment-delete";
      remove.textContent = "删除";
      remove.setAttribute("aria-label", "删除本地评论");
      let confirmTimer = 0;
      remove.addEventListener("click", async () => {
        if (remove.dataset.confirm !== "1") {
          remove.dataset.confirm = "1";
          remove.textContent = "确认删除";
          window.clearTimeout(confirmTimer);
          confirmTimer = window.setTimeout(() => {
            remove.dataset.confirm = "0";
            remove.textContent = "删除";
          }, 10000);
          return;
        }
        window.clearTimeout(confirmTimer);
        remove.disabled = true;
        remove.setAttribute("aria-busy", "true");
        try {
          const data = await api(`${commentsEndpoint}/${encodeURIComponent(comment.id || "")}`, { method: "DELETE" });
          comments = Array.isArray(data.comments) ? data.comments : comments.filter((itemComment) => itemComment.id !== comment.id);
          renderLocalComments();
          showBrowserToast("已删除本地评论");
        } catch (error) {
          remove.disabled = false;
          remove.removeAttribute("aria-busy");
          remove.dataset.confirm = "0";
          remove.textContent = "删除";
          showBrowserToast(error.message || "本地评论删除失败");
        }
      });
      body.append(meta, content, remove);
      item.append(avatar, body);
      return item;
    };

    const loadLocalComments = async () => {
      loading = true;
      loadError = "";
      renderLocalComments();
      try {
        const data = await api(commentsEndpoint);
        comments = Array.isArray(data.comments) ? data.comments : [];
        remoteComments = Array.isArray(data.remoteComments) ? data.remoteComments : [];
      } catch (error) {
        loadError = error.message || "本地评论读取失败";
      } finally {
        loading = false;
        renderLocalComments();
        renderRemoteComments();
      }
    };

    sync.addEventListener("click", async () => {
      if (sync.getAttribute("aria-busy") === "true") return;
      sync.setAttribute("aria-busy", "true");
      sync.disabled = true;
      sync.textContent = "同步中";
      try {
        const data = await api(`${commentsEndpoint}/sync`, {
          method: "POST",
          body: { maxComments: 100 }
        });
        remoteComments = Array.isArray(data.remoteComments) ? data.remoteComments : [];
        renderRemoteComments();
        showBrowserToast(`已同步 ${formatNumber(data.imported || remoteComments.length)} 条抖音评论`);
      } catch (error) {
        showBrowserToast(error.message || "抖音评论同步失败");
      } finally {
        sync.removeAttribute("aria-busy");
        sync.disabled = false;
        sync.textContent = "同步评论";
      }
    });

    const syncComposer = () => {
      const value = textarea.value || "";
      const length = Array.from(value).length;
      characterCount.textContent = `${length}/500`;
      submit.disabled = !value.trim() || submit.getAttribute("aria-busy") === "true";
      composerField.classList.toggle("is-dirty", Boolean(value));
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(104, Math.max(28, textarea.scrollHeight || 28))}px`;
    };
    textarea.addEventListener("input", syncComposer);
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!submit.disabled) composer.requestSubmit();
    });
    composer.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = textarea.value.trim();
      if (!body || submit.getAttribute("aria-busy") === "true") return;
      submit.setAttribute("aria-busy", "true");
      submit.disabled = true;
      submit.textContent = "发送中";
      try {
        const data = await api(commentsEndpoint, { method: "POST", body: { body } });
        comments = Array.isArray(data.comments) ? data.comments : [data.comment, ...comments].filter(Boolean);
        textarea.value = "";
        renderLocalComments();
        scroll.scrollTop = 0;
        showBrowserToast("本地评论已保存");
      } catch (error) {
        showBrowserToast(error.message || "本地评论保存失败");
      } finally {
        submit.removeAttribute("aria-busy");
        submit.textContent = "发送";
        syncComposer();
        textarea.focus();
      }
    });

    wrap.append(heading, scroll, composer);
    renderRemoteComments();
    renderLocalComments();
    loadLocalComments();
    return wrap;
  }

}
