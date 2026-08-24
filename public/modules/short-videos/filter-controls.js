export function createShortVideoFilterControls(deps) {
  const {
    clearSelection,
    formatNumber,
    isAuthorDetailPage,
    loadVideos,
    normalizeAuthorAccountStatus,
    normalizeDeleted,
    normalizeSort,
    showError,
    state
  } = deps;

  function renderDeletedControl(data = {}) {
    const label = document.createElement("label");
    label.className = "short-video-sort-control short-video-deleted-control";
    const text = document.createElement("span");
    text.textContent = "状态";
    const select = document.createElement("select");
    select.className = "short-video-sort-select";
    select.setAttribute("aria-label", "作者作品状态筛选");
    const deletedTotal = Math.max(0, Number(data.deletedTotal || 0));
    for (const [value, optionLabel] of [["all", "全部作品"], ["deleted", `主页已删除 (${formatNumber(deletedTotal)})`]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = optionLabel;
      select.append(option);
    }
    select.value = normalizeDeleted(state.shortVideo.deleted);
    select.addEventListener("change", () => {
      const nextDeleted = normalizeDeleted(select.value);
      if (normalizeDeleted(state.shortVideo.deleted) === nextDeleted) return;
      state.shortVideo.deleted = nextDeleted;
      state.shortVideo.current = null;
      clearSelection();
      loadVideos({ replaceRoute: true }).catch(showError);
    });
    label.append(text, select);
    return label;
  }

  function renderSortControl() {
    const label = document.createElement("label");
    label.className = "short-video-sort-control";
    const text = document.createElement("span");
    text.textContent = isAuthorDetailPage() ? "日期" : "排序";
    const select = document.createElement("select");
    select.className = "short-video-sort-select";
    const timeLabel = state.shortVideo.source === "liked" ? "入库时间" : "发布时间";
    for (const item of [
      ["recommended", "推荐排序"], ["watched", "最近观看"],
      ["published", `${timeLabel}倒序`], ["publishedAsc", `${timeLabel}正序`],
      ["likes", "点赞最多"], ["likesAsc", "点赞最少"],
      ["comments", "评论最多"], ["duration", "时长最长"],
      ["size", "文件大小"]
    ]) {
      const option = document.createElement("option");
      option.value = item[0];
      option.textContent = item[1];
      select.append(option);
    }
    select.value = normalizeSort(state.shortVideo.sort);
    select.addEventListener("change", () => {
      const nextSort = normalizeSort(select.value);
      if ((state.shortVideo.sort || "published") === nextSort) return;
      state.shortVideo.sort = nextSort;
      state.shortVideo.current = null;
      clearSelection();
      loadVideos({ replaceRoute: true }).catch(showError);
    });
    label.append(text, select);
    return label;
  }

  function renderAuthorAccountStatusControl() {
    const wrap = document.createElement("div");
    wrap.className = "short-video-delete-actions short-video-author-account-controls";
    const label = document.createElement("label");
    label.className = "short-video-sort-control";
    const text = document.createElement("span");
    text.textContent = "账号状态";
    const select = document.createElement("select");
    select.className = "short-video-sort-select";
    select.setAttribute("aria-label", "作者账号状态筛选");
    for (const [value, optionLabel] of [
      ["all", "全部账号"],
      ["banned", `已封禁 (${formatNumber(state.shortVideo.authorBannedTotal || 0)})`]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = optionLabel;
      select.append(option);
    }
    select.value = normalizeAuthorAccountStatus(state.shortVideo.authorAccountStatus);
    select.addEventListener("change", () => {
      const nextStatus = normalizeAuthorAccountStatus(select.value);
      if (nextStatus === state.shortVideo.authorAccountStatus) return;
      state.shortVideo.authorAccountStatus = nextStatus;
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      loadVideos({ replaceRoute: true }).catch(showError);
    });
    label.append(text, select);
    wrap.append(label);
    return wrap;
  }

  return Object.freeze({ renderAuthorAccountStatusControl, renderDeletedControl, renderSortControl });
}
