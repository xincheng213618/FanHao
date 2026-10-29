export function createShortVideoTranscodeManagementPage({ api, els, formatBytes, setMainHeader, state }) {
  let viewPromise = null;
  let pageGeneration = 0;
  let currentPage = null;
  let mountedView = null;

  function activate() {
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    setMainHeader("转码管理", "短视频 / FFmpeg 后台任务");
  }

  function render() {
    stop();
    const generation = pageGeneration;
    const page = document.createElement("section");
    currentPage = page;
    page.className = "short-video-transcode-page";
    const loading = document.createElement("div");
    loading.className = "short-video-transcode-loading";
    loading.textContent = "正在载入 FFmpeg 转码管理…";
    page.append(loading);
    els.workGrid.append(page);
    const isCurrent = () => generation === pageGeneration && currentPage === page && page.isConnected
      && state.activeView === "shortVideos" && state.shortVideo.mode === "transcoding";
    ensureView().then((view) => {
      if (!isCurrent()) return;
      mountedView = view;
      view.mount(page);
    }).catch((error) => {
      if (!isCurrent()) return;
      mountedView?.stopPolling?.();
      mountedView = null;
      page.replaceChildren(loading);
      loading.classList.add("short-video-transcode-error");
      loading.textContent = error?.message || "转码管理页面加载失败";
    });
  }

  function stop() {
    pageGeneration += 1;
    currentPage = null;
    const view = mountedView;
    mountedView = null;
    view?.stopPolling?.();
  }

  function ensureView() {
    if (viewPromise) return viewPromise;
    const moduleUrl = "/modules/short-videos/transcode-status-view.js?v=20261027-transcode-lifecycle-01";
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
