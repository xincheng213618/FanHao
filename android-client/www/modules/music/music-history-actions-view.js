export function createMusicHistoryActionsView(deps) {
  const {
    deleteJson,
    getActiveUrl,
    loadSmartPlaylists,
    renderSheetHandle,
    renderShell,
    setMusicSymbol,
    state,
    symbolButton
  } = deps;

  function renderHistoryManagement() {
    const management = symbolButton("more", () => {
      state.historyActionsOpen = true;
      renderShell();
    }, false, "music-mobile-playlist-back music-mobile-history-management", "管理播放记录");
    management.setAttribute("aria-expanded", state.historyActionsOpen ? "true" : "false");
    return management;
  }

  function closeHistoryActions() {
    if (!state.historyActionsOpen) return false;
    state.historyActionsOpen = false;
    renderShell();
    return true;
  }

  function renderHistoryActionsBackdrop() {
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-mobile-settings-backdrop music-mobile-history-actions-backdrop";
    backdrop.setAttribute("aria-label", "关闭播放记录管理");
    backdrop.addEventListener("click", closeHistoryActions);
    return backdrop;
  }

  function renderHistoryActionsSheet() {
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-settings-sheet music-mobile-history-actions-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "管理播放记录");
    const head = document.createElement("header");
    head.className = "music-mobile-history-actions-head";
    const title = document.createElement("strong");
    title.textContent = "播放记录";
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "完成";
    done.addEventListener("click", closeHistoryActions);
    head.append(title, done);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "music-mobile-history-clear";
    clear.disabled = !currentTracks().length;
    setMusicSymbol(clear, "delete");
    const text = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = "清空播放记录";
    const description = document.createElement("small");
    description.textContent = "只清除历史列表，当前播放不会停止。";
    text.append(label, description);
    clear.append(text);
    clear.addEventListener("click", () => clearPlaybackHistory().catch(() => {}));
    sheet.append(renderSheetHandle(), head, clear);
    return sheet;
  }

  async function clearPlaybackHistory() {
    if (state.mode !== "history") return;
    if (!window.confirm("清空全部播放记录？当前播放不会停止。")) return;
    state.historyActionsOpen = false;
    state.loading = true;
    state.status = "正在清空播放记录";
    renderShell();
    try {
      await deleteJson(getActiveUrl(), "/api/music/history");
      state.data = {
        ...(state.data || {}),
        tracks: [],
        rawTracks: [],
        rawLoaded: 0,
        total: 0,
        hasMore: false
      };
      state.loading = false;
      state.status = "";
      await loadSmartPlaylists();
      renderShell();
    } catch (error) {
      state.loading = false;
      state.status = error?.message || "清空播放记录失败";
      renderShell();
    }
  }

  function currentTracks() {
    return Array.isArray(state.data?.tracks) ? state.data.tracks : [];
  }

  return {
    closeHistoryActions,
    renderHistoryActionsBackdrop,
    renderHistoryActionsSheet,
    renderHistoryManagement
  };
}
