export function createShortVideoTranscodeManagementPage({ api, els, formatBytes, setMainHeader, state }) {
  let viewPromise = null;

  function activate() {
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    setMainHeader("转码管理", "短视频 / FFmpeg 后台任务");
  }

  function render() {
    const page = document.createElement("section");
    page.className = "short-video-transcode-page";
    const loading = document.createElement("div");
    loading.className = "short-video-transcode-loading";
    loading.textContent = "正在载入 FFmpeg 转码管理…";
    page.append(loading);
    els.workGrid.append(page);
    ensureView().then((view) => {
      if (state.shortVideo.mode !== "transcoding" || !page.isConnected) return;
      view.mount(page);
    }).catch((error) => {
      if (!page.isConnected) return;
      loading.classList.add("short-video-transcode-error");
      loading.textContent = error?.message || "转码管理页面加载失败";
    });
  }

  function stop() {
    viewPromise?.then((view) => view.stopPolling?.()).catch(() => {});
  }

  function ensureView() {
    if (viewPromise) return viewPromise;
    const moduleUrl = "/modules/short-videos/transcode-status-view.js?v=20260720-stable-regions-09";
    viewPromise = import(moduleUrl).then((module) => {
      if (typeof module.createShortVideoTranscodeStatusView !== "function") throw new Error("转码管理页面加载失败");
      return module.createShortVideoTranscodeStatusView({ api, formatBytes });
    }).catch((error) => {
      viewPromise = null;
      throw error;
    });
    return viewPromise;
  }

  return Object.freeze({ activate, render, stop });
}
