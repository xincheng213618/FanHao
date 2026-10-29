const FAVORITES_KEY = "fanhao.manga.favorites";
const PROGRESS_KEY = "fanhao.manga.progress";
const POSITION_KEY = "fanhao.manga.positions";

export function createMangaPage(deps) {
  const {
    api,
    cancelScheduledWorkRendering,
    disconnectPeopleIndexAutoload,
    els,
    formatDateTime,
    formatNumber,
    hidePersonProfile,
    pushRoute,
    resetProgressiveCoverLoading,
    setMainHeader,
    state,
    syncRouteAfterNavigation,
    writeStoredFlag
  } = deps;
  const updatePolls = new Map();
  let readerOwner = null;
  let readerGeneration = 0;
  let readerView = null;
  let chapterRead = null;
  let libraryVersion = 0;
  const libraryReads = new Set();
  let readerPosition = null;
  let directoryReturn = null;
  let detailView = null;
  let libraryView = null;
  let libraryComicRead = null;
  let libraryComicFeedback = null;

  function clearLibraryView() {
    clearLibraryComicRead();
    libraryView?.cards.clear();
    libraryView = null;
  }

  function clearLibraryComicRead({ keepFeedback = false } = {}) {
    const button = libraryComicRead?.view.cards.get(String(libraryComicRead.comicId))?.button;
    button?.removeAttribute("aria-busy");
    button?.removeAttribute("aria-disabled");
    libraryComicRead = null;
    if (!keepFeedback) {
      libraryComicFeedback?.remove();
      libraryComicFeedback = null;
    }
  }

  function currentLibraryComicRead() {
    const read = libraryComicRead;
    return read && currentLibraryView(read.view) && readerRequestCurrent(read.owner) ? read : null;
  }

  function retireLibraryComicRead() {
    const read = currentLibraryComicRead();
    if (!read) return;
    read.owner.controller.abort();
    readerOwner = null;
    clearLibraryComicRead();
    read.view.generation = ++readerGeneration;
    read.view.page.dataset.readerGeneration = String(readerGeneration);
    state.manga.loading = false;
    state.manga.status = "";
  }

  function syncLibraryComicFeedback() {
    const read = currentLibraryComicRead();
    if (!read) { clearLibraryComicRead(); return; }
    const record = read.view.cards.get(String(read.comicId)), busy = read.phase === "pending";
    if (record) {
      if (busy) { record.button.setAttribute("aria-busy", "true"); record.button.setAttribute("aria-disabled", "true"); }
      else { record.button.removeAttribute("aria-busy"); record.button.removeAttribute("aria-disabled"); }
    }
    if (!libraryComicFeedback?.isConnected) {
      const node = document.createElement("aside");
      node.className = "manga-library-open-feedback";
      const message = document.createElement("span");
      message.className = "manga-library-open-message";
      message.tabIndex = 0;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "manga-library-open-retry";
      retry.hidden = true;
      retry.addEventListener("click", () => {
        const current = currentLibraryComicRead();
        if (!current || current.phase !== "failed" || node !== libraryComicFeedback || !node.isConnected) return;
        const comic = state.manga.data?.comics?.find(item => String(item.id) === String(current.comicId));
        if (!comic || !current.view.cards.has(String(comic.id)) || !matchesComicQuery(comic, state.manga.query.trim().normalize("NFKC").toLowerCase())) return;
        void openComic(comic.id, { libraryView: current.view });
      });
      node.append(message, retry);
      libraryComicFeedback = node;
      els.workGrid.append(node);
    }
    const node = libraryComicFeedback;
    node.setAttribute("role", busy ? "status" : "alert");
    const text = busy ? `正在读取《${record?.title.textContent || read.title}》的资料和目录` : `《${read.title}》读取失败：${read.error}`;
    if (node.firstElementChild.textContent !== text) node.firstElementChild.textContent = text;
    const retry = node.lastElementChild;
    if (!busy) retry.hidden = false;
    retry.textContent = busy ? "正在读取" : "重试目录";
    retry.disabled = !record;
    retry.setAttribute("aria-disabled", String(busy));
    if (busy) retry.setAttribute("aria-busy", "true");
    else retry.removeAttribute("aria-busy");
  }

  function clearDetailView() {
    detailView?.observer?.disconnect();
    detailView = null;
  }

  function stopReaderPosition() {
    readerPosition?.save();
    readerPosition?.stop();
    readerPosition = null;
  }

  function currentReaderView(view) {
    return Boolean(view && readerView === view && view.page.isConnected && els.workGrid.contains(view.page)
      && state.activeView === "manga" && state.manga.chapter === view.chapter
      && state.manga.comic?.id === view.comicId && readerGeneration === view.generation);
  }

  function currentChapterSource(view) {
    return currentReaderView(view) || currentDetailView(view);
  }

  function beginReaderRequest(type, comicId = "", source = null) {
    ensureState();
    const keepReader = type === "chapter" && currentReaderView(source) && source.comicId === comicId;
    const keepDetail = type === "chapter" && currentDetailView(source) && source.comicId === comicId;
    const keepLibrary = type === "comic" && currentLibraryView(source);
    directoryReturn = null;
    if (keepLibrary) clearLibraryComicRead({ keepFeedback: true });
    else clearLibraryView();
    if (!keepDetail) clearDetailView();
    if (keepReader) readerPosition?.retain();
    else { stopReaderPosition(); readerView = null; }
    readerOwner?.controller.abort();
    const owner = { type, comicId, generation: ++readerGeneration, controller: new AbortController() };
    readerOwner = owner;
    if (keepReader || keepDetail) source.generation = readerGeneration;
    if (keepLibrary) {
      source.generation = readerGeneration;
      source.page.dataset.readerGeneration = String(readerGeneration);
      owner.libraryView = source;
    }
    chapterRead = null;
    state.manga.status = "";
    return owner;
  }

  function readerRequestCurrent(owner) {
    return Boolean(owner && owner === readerOwner && owner.generation === readerGeneration
      && !owner.controller.signal.aborted && state.activeView === "manga");
  }

  function resetReader({ keepComic = false } = {}) {
    ensureState();
    directoryReturn = null;
    clearLibraryView();
    clearDetailView();
    stopReaderPosition();
    readerView = null;
    chapterRead = null;
    readerOwner?.controller.abort();
    readerOwner = null;
    readerGeneration += 1;
    state.manga.loading = false;
    state.manga.status = "";
    state.manga.chapter = null;
    if (!keepComic) state.manga.comic = null;
  }

  async function readLibrary(options = {}) {
    const version = ++libraryVersion;
    const removed = new Set();
    libraryReads.add(removed);
    try {
      const data = await api("/api/manga", options);
      const current = removed.size && Array.isArray(data.comics)
        ? { ...data, comics: data.comics.filter(comic => !removed.has(comic.id)) } : data;
      if (version === libraryVersion && !options.signal?.aborted && state.activeView === "manga") state.manga.data = current;
      return current;
    } finally {
      libraryReads.delete(removed);
    }
  }

  function refreshBackgroundView() {
    if (state.activeView !== "manga" || state.manga.loading) return;
    if (state.manga.chapter) syncChapterReadFeedback();
    else renderView();
  }

  function readerChapterNeighbors(comic, chapter) {
    const chapters = comic?.chapters || [];
    const position = chapters.findIndex(item => Number(item.index) === Number(chapter?.index));
    return { previous: position > 0 ? chapters[position - 1] : null,
      next: position >= 0 && position < chapters.length - 1 ? chapters[position + 1] : null };
  }

  function refreshReaderChapterNavigation() {
    const page = els.workGrid.querySelector(".manga-reader");
    const comic = state.manga.comic, chapter = state.manga.chapter;
    if (!page || !comic || !chapter || page.dataset.comicId !== String(comic.id)
      || page.dataset.chapterIndex !== String(chapter.index)) return;
    for (const [action, adjacent] of Object.entries(readerChapterNeighbors(comic, chapter))) {
      for (const button of page.querySelectorAll(`[data-action="${action}"]`)) {
        button.disabled = !chapterAvailable(adjacent);
        setChapterButtonBusy(button, Boolean(state.manga.loading));
        button.title = adjacent ? chapterAvailable(adjacent) ? adjacent.title || `第 ${adjacent.index} 话`
          : `${action === "previous" ? "上一话" : "下一话"}尚未下载完成` : "";
      }
    }
  }

  function ensureState() {
    state.manga ||= {};
    state.manga.data ||= null;
    state.manga.comic ||= null;
    state.manga.chapter ||= null;
    state.manga.query ||= "";
    state.manga.sort ||= "updated";
    state.manga.loading = Boolean(state.manga.loading);
    state.manga.status ||= "";
    state.manga.updates ||= {};
    state.manga.deletingComicId ||= "";
    state.manga.deleteError ||= "";
    state.manga.addOpen = Boolean(state.manga.addOpen);
    state.manga.addUrl ||= "";
    state.manga.addJob ||= null;
    state.manga.addError ||= "";
    state.manga.addCatalogSyncedJobId ||= "";
    state.manga.fitWidth = state.manga.fitWidth !== false;
  }

  function enter(options = {}) {
    ensureState();
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    hidePersonProfile();
    disconnectPeopleIndexAutoload();
    cancelScheduledWorkRendering();
    resetProgressiveCoverLoading();
    setMainHeader("漫画馆", "独立漫画书库");
    renderStats();
    renderView();
    if (!options.deferInitialLoad && !state.manga.data) {
      if (state.manga.comic || state.manga.chapter) void readLibrary().then(refreshBackgroundView, () => {});
      else void loadLibrary({ skipRoute: true });
    }
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route = {}) {
    ensureState();
    resetReader();
    state.manga.query = route.mangaQuery || "";
    state.manga.sort = ["updated", "title", "chapters"].includes(route.mangaSort) ? route.mangaSort : "updated";
  }

  async function openRouteTarget(route = {}) {
    ensureState();
    if (route.mangaComicId && route.mangaChapterIndex) {
      const owner = beginReaderRequest("chapter", route.mangaComicId);
      const comic = await openComic(route.mangaComicId, { skipRoute: true, render: false }, owner);
      if (comic && readerRequestCurrent(owner)) await openChapter(route.mangaChapterIndex, { skipRoute: true, restorePosition: true }, owner);
      return;
    }
    if (route.mangaComicId) {
      await openComic(route.mangaComicId, { skipRoute: true });
      return;
    }
    await loadLibrary({ skipRoute: true });
  }

  async function loadLibrary(options = {}) {
    const owner = beginReaderRequest("library");
    state.manga.comic = null;
    state.manga.chapter = null;
    state.manga.loading = true;
    state.manga.status = "正在读取漫画书库";
    renderView();
    try {
      await readLibrary({ signal: owner.controller.signal });
      if (!readerRequestCurrent(owner)) return null;
      state.manga.status = "";
    } catch (error) {
      if (!readerRequestCurrent(owner)) return null;
      state.manga.status = error.message || "漫画书库读取失败";
    } finally {
      if (readerRequestCurrent(owner)) {
        state.manga.loading = false;
        renderView();
        if (!options.skipRoute) syncRouteAfterNavigation(options);
      }
    }
    return state.manga.data;
  }

  async function openComic(comicId, options = {}, owner = beginReaderRequest("comic", comicId, options.libraryView)) {
    state.manga.comic = null;
    state.manga.chapter = null;
    state.manga.deleteError = "";
    state.manga.loading = true;
    state.manga.status = "正在读取作品资料和目录";
    if (owner.libraryView) {
      const record = owner.libraryView.cards.get(String(comicId));
      libraryComicRead = { owner, view: owner.libraryView, comicId, title: record?.title.textContent || String(comicId), phase: "pending", error: "" };
      syncLibraryComicFeedback();
    } else if (options.render !== false) renderView();
    try {
      const data = await api(`/api/manga/${encodeURIComponent(comicId)}`, { signal: owner.controller.signal });
      if (!readerRequestCurrent(owner)) return null;
      clearLibraryComicRead();
      state.manga.comic = data.comic;
      state.manga.updates[comicId] = data.update || { status: "idle" };
      state.manga.chapter = null;
      state.manga.status = "";
      if (options.render !== false) renderView();
      syncRouteAfterNavigation(options);
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      if (data.update?.status === "running") void watchComicUpdate(comicId);
      return state.manga.comic;
    } catch (error) {
      if (!readerRequestCurrent(owner)) return null;
      state.manga.status = error.message || "漫画详情读取失败";
      if (libraryComicRead?.owner === owner) { libraryComicRead.phase = "failed"; libraryComicRead.error = state.manga.status; }
      renderView();
      return null;
    } finally {
      if (readerRequestCurrent(owner)) {
        state.manga.loading = false;
        syncLibraryComicFeedback();
      }
    }
  }

  function comicUpdate(comicId) {
    return state.manga.updates?.[comicId] || { status: "idle" };
  }

  function isUpdateRunning(job) {
    return ["starting", "running"].includes(String(job?.status || ""));
  }

  function updateButtonLabel(job) {
    if (isUpdateRunning(job)) {
      const completed = Number(job.completedChapters || 0);
      const pending = Number(job.pendingChapters);
      return Number.isFinite(pending) && pending > 0
        ? `更新中 ${Math.min(pending, completed + 1)}/${pending}`
        : "正在检查更新";
    }
    if (job?.status === "failed") return "重试更新";
    if (job?.status === "complete") return "再次更新";
    return "更新漫画";
  }

  function updateStatusText(job) {
    if (!job || job.status === "idle") return "";
    if (job.message) return String(job.message);
    if (job.status === "starting") return "正在启动增量更新";
    if (job.status === "running") return "正在检查远程目录";
    if (job.status === "failed") return "漫画更新失败";
    return "漫画更新完成";
  }

  function jobProgressMarkup(job) {
    if (!job || job.status === "idle") return "";
    const percent = Math.max(0, Math.min(100, Number(job.progressPercent || (job.status === "complete" ? 100 : 0))));
    const totalChapters = Math.max(0, Number(job.totalChapters || 0));
    const completedChapters = Math.min(totalChapters, Math.max(0, Number(job.cachedChapters || 0)) + Math.max(0, Number(job.completedChapters || 0)));
    const stats = [];
    if (job.totalChapters != null) stats.push(`目录 ${formatNumber(job.totalChapters)} 章`);
    if (job.totalChapters != null) stats.push(`已完成 ${formatNumber(completedChapters)} 章`);
    if (job.totalChapters != null) stats.push(`剩余 ${formatNumber(Math.max(0, totalChapters - completedChapters))} 章`);
    if (Number(job.totalImages) > 0) stats.push(`本章图片 ${formatNumber(job.completedImages || 0)}/${formatNumber(job.totalImages)}`);
    if (Number(job.failedChapters || job.failedImages) > 0) {
      stats.push(`失败 ${formatNumber(Number(job.failedImages || 0) + Number(job.failedChapters || 0))}`);
    }
    if (Number(job.downloadedBytes) > 0) stats.push(formatBytes(job.downloadedBytes));
    const current = job.currentChapterTitle
      ? `<span class="manga-job-current">${escapeHtml(job.currentChapterTitle)}</span>`
      : "";
    return `
      <div class="manga-job-progress is-${escapeAttr(job.status)}" role="status">
        <div class="manga-job-progress-head"><strong>${escapeHtml(updateStatusText(job))}</strong><span>${Math.round(percent)}%</span></div>
        <div class="manga-job-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><i style="width:${percent}%"></i></div>
        ${current}<div class="manga-job-progress-meta">${stats.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      </div>
    `;
  }

  function chapterAvailable(chapter) {
    return ["done", "repaired"].includes(String(chapter?.status || "").toLowerCase())
      && Number(chapter?.downloadedCount || 0) > 0;
  }

  function mangaWholeDownloadReady(comic = {}) {
    const chapterCount = Math.max(0, Number(comic.chapterCount || 0));
    const doneChapterCount = Math.max(0, Number(comic.doneChapterCount || 0));
    const imageCount = Math.max(0, Number(comic.imageCount || 0));
    const downloadedCount = Math.max(0, Number(comic.downloadedCount || 0));
    const failedCount = Math.max(0, Number(comic.failedCount || 0));
    return chapterCount > 0
      && doneChapterCount >= chapterCount
      && imageCount > 0
      && downloadedCount >= imageCount
      && failedCount === 0;
  }

  async function startComicUpdate(comicId) {
    if (!comicId || isUpdateRunning(comicUpdate(comicId))) return;
    state.manga.updates[comicId] = { status: "starting", message: "正在启动增量更新" };
    refreshBackgroundView();
    try {
      const result = await api(`/api/manga/${encodeURIComponent(comicId)}/update`, { method: "POST" });
      state.manga.updates[comicId] = result.job || { status: "running" };
      refreshBackgroundView();
      if (isUpdateRunning(result.job)) {
        void watchComicUpdate(comicId);
      } else if (result.job?.status === "complete") {
        await refreshComicAfterUpdate(comicId, result.job);
      }
    } catch (error) {
      state.manga.updates[comicId] = {
        status: "failed",
        message: error.message || "漫画更新启动失败"
      };
      refreshBackgroundView();
    }
  }

  function watchComicUpdate(comicId) {
    if (updatePolls.has(comicId)) return updatePolls.get(comicId);
    const polling = (async () => {
      while (isUpdateRunning(comicUpdate(comicId))) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        const data = await api(`/api/manga/${encodeURIComponent(comicId)}/update`);
        state.manga.updates[comicId] = data.job || { status: "idle" };
        if (state.manga.comic?.id === comicId) refreshBackgroundView();
      }
      const job = comicUpdate(comicId);
      if (job.status === "complete") await refreshComicAfterUpdate(comicId, job);
      return job;
    })().catch((error) => {
      state.manga.updates[comicId] = {
        status: "failed",
        message: error.message || "漫画更新状态读取失败"
      };
      if (state.manga.comic?.id === comicId) refreshBackgroundView();
      return state.manga.updates[comicId];
    }).finally(() => updatePolls.delete(comicId));
    updatePolls.set(comicId, polling);
    return polling;
  }

  async function refreshComicAfterUpdate(comicId, finishedJob) {
    const generation = readerGeneration;
    const [detail] = await Promise.all([
      api(`/api/manga/${encodeURIComponent(comicId)}`),
      readLibrary()
    ]);
    state.manga.updates[comicId] = detail.update?.status === "running"
      ? detail.update
      : finishedJob;
    if (generation === readerGeneration && state.manga.comic?.id === comicId) {
      state.manga.comic = { ...state.manga.comic, ...detail.comic };
    }
    refreshBackgroundView();
  }

  async function startAddComic(url) {
    const value = String(url || "").trim();
    if (!value || isUpdateRunning(state.manga.addJob)) return;
    state.manga.addUrl = value;
    state.manga.addError = "";
    state.manga.addCatalogSyncedJobId = "";
    state.manga.addJob = { status: "starting", message: "正在启动漫画采集", progressPercent: 1 };
    refreshBackgroundView();
    try {
      const result = await api("/api/manga/add", { method: "POST", body: { url: value } });
      state.manga.addJob = result.job;
      refreshBackgroundView();
      if (isUpdateRunning(result.job)) void watchAddJob(result.job.id);
      else if (result.job?.status === "complete") await refreshLibraryAfterAdd();
    } catch (error) {
      state.manga.addJob = { status: "failed", message: error.message || "漫画添加失败" };
      state.manga.addError = error.message || "漫画添加失败";
      refreshBackgroundView();
    }
  }

  function watchAddJob(jobId) {
    const pollKey = `add:${jobId}`;
    if (updatePolls.has(pollKey)) return updatePolls.get(pollKey);
    const polling = (async () => {
      while (isUpdateRunning(state.manga.addJob)) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        const data = await api(`/api/manga/jobs/${encodeURIComponent(jobId)}`);
        state.manga.addJob = data.job;
        if (data.job?.comicId) state.manga.updates[data.job.comicId] = data.job;
        if (data.job?.totalChapters != null && state.manga.addCatalogSyncedJobId !== jobId) {
          const library = await readLibrary();
          if (library.comics?.some((comic) => comic.id === data.job.comicId)) {
            state.manga.addCatalogSyncedJobId = jobId;
          }
        }
        if (!state.manga.comic) refreshBackgroundView();
      }
      if (state.manga.addJob?.status === "complete") await refreshLibraryAfterAdd();
      return state.manga.addJob;
    })().catch((error) => {
      state.manga.addJob = { status: "failed", message: error.message || "漫画采集状态读取失败" };
      state.manga.addError = state.manga.addJob.message;
      if (!state.manga.comic) refreshBackgroundView();
      return state.manga.addJob;
    }).finally(() => updatePolls.delete(pollKey));
    updatePolls.set(pollKey, polling);
    return polling;
  }

  async function refreshLibraryAfterAdd() {
    await readLibrary();
    if (!state.manga.comic) refreshBackgroundView();
  }

  async function deleteComicFromLibrary(comic) {
    if (!comic?.id || state.manga.deletingComicId || isUpdateRunning(comicUpdate(comic.id))) return;
    const confirmed = window.confirm(
      `确定删除《${comic.title}》吗？\n\n整本漫画会移入本地回收区，并从自动采集列表移除。`
    );
    if (!confirmed) return;
    libraryVersion += 1;
    if (readerOwner?.comicId === comic.id) resetReader({ keepComic: true });
    state.manga.deletingComicId = comic.id;
    state.manga.deleteError = "";
    state.manga.status = "正在把漫画移入回收区";
    renderView();
    try {
      await api(`/api/manga/${encodeURIComponent(comic.id)}`, { method: "DELETE" });
      for (const removed of libraryReads) removed.add(comic.id);
      if (state.manga.data?.comics) {
        state.manga.data.comics = state.manga.data.comics.filter((item) => item.id !== comic.id);
      }
      delete state.manga.updates[comic.id];
      forgetComicState(comic.id);
      if (state.manga.comic?.id === comic.id || readerOwner?.comicId === comic.id) {
        resetReader();
        state.manga.status = `《${comic.title}》已移入回收区`;
        renderView();
        pushRoute({ mangaComicId: "", mangaChapterIndex: "" });
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      } else {
        refreshBackgroundView();
      }
    } catch (error) {
      if (state.manga.comic?.id === comic.id) state.manga.deleteError = error.message || "漫画删除失败";
    } finally {
      state.manga.deletingComicId = "";
      if (state.manga.comic?.id === comic.id) refreshBackgroundView();
    }
  }

  async function openChapter(chapterIndex, options = {}, owner) {
    const comic = state.manga.comic;
    if (!comic) return;
    if (!owner && chapterRead?.phase === "loading" && readerRequestCurrent(chapterRead.owner)
        && chapterRead.comicId === comic.id && Number(chapterRead.index) === Number(chapterIndex)
        && chapterRead.restorePosition === Boolean(options.restorePosition)) return chapterRead.promise;
    const source = currentReaderView(readerView) ? readerView : currentDetailView(detailView) ? detailView : null;
    owner ||= beginReaderRequest("chapter", comic.id, source);
    if (!readerRequestCurrent(owner) || owner.comicId !== comic.id) return null;
    const read = chapterRead = { owner, comicId: comic.id, index: chapterIndex, options: { ...options },
      restorePosition: Boolean(options.restorePosition), phase: "loading", view: currentChapterSource(source) ? source : null };
    state.manga.loading = true;
    state.manga.status = "正在读取章节";
    if (read.view) syncChapterReadFeedback(); else renderView();
    read.promise = (async () => {
      try {
        const data = await api(`/api/manga/${encodeURIComponent(comic.id)}/chapters/${encodeURIComponent(String(chapterIndex))}`, { signal: owner.controller.signal });
        if (!readerRequestCurrent(owner) || state.manga.comic?.id !== comic.id) return null;
        // Flush the visible source chapter before changing its identity.
        readerPosition?.retain();
        stopReaderPosition();
        chapterRead = null;
        state.manga.comic = { ...state.manga.comic, ...(data.comic || {}) };
        state.manga.chapter = { ...data.chapter, comicId: comic.id };
        state.manga.status = "";
        state.manga.loading = false;
        saveProgress(comic.id, data.chapter?.index);
        renderView({ position: options.restorePosition ? readingPositionFor(comic.id, data.chapter?.index) : null });
        syncRouteAfterNavigation(options);
        return state.manga.chapter;
      } catch (error) {
        if (!readerRequestCurrent(owner)) return null;
        read.phase = "failed";
        read.message = error.message || "章节读取失败";
        state.manga.status = read.message;
        state.manga.loading = false;
        syncChapterReadFeedback();
      } finally {
        if (readerRequestCurrent(owner)) {
          state.manga.loading = false;
          refreshReaderChapterNavigation();
        }
      }
    })();
    return read.promise;
  }

  function setChapterButtonBusy(button, busy) {
    if (!button) return;
    if (busy) { button.setAttribute("aria-busy", "true"); button.setAttribute("aria-disabled", "true"); }
    else { button.removeAttribute("aria-busy"); button.removeAttribute("aria-disabled"); }
  }

  function detailReadIndex(comic) {
    const available = comic.chapters?.filter(chapterAvailable) || [], saved = progressFor(comic.id);
    return available.some(item => Number(item.index) === Number(saved)) ? saved : available[0]?.index;
  }

  function syncChapterReadFeedback() {
    const view = currentReaderView(readerView) ? readerView : currentDetailView(detailView) ? detailView : null;
    if (!view) return;
    const read = chapterRead && readerRequestCurrent(chapterRead.owner) && chapterRead.comicId === state.manga.comic?.id ? chapterRead : null;
    if (read && (!read.view || read.view.comicId === view.comicId && read.view.chapter === view.chapter
        && read.view.generation === read.owner.generation && view.generation === read.owner.generation)) read.view = view;
    const current = read && read.view === view;
    const busy = Boolean(current && read.phase === "loading");
    refreshReaderChapterNavigation();
    if (currentDetailView(view)) {
      for (const record of view.rows.values()) setChapterButtonBusy(record.button, busy && !read.restorePosition && Number(record.chapter.index) === Number(read.index));
      setChapterButtonBusy(view.page.querySelector('[data-action="read"]'), busy && read.restorePosition && Number(detailReadIndex(state.manga.comic)) === Number(read.index));
    }
    if (!current) { view.feedback?.remove(); view.feedback = null; return; }
    if (!view.feedback) {
      const node = document.createElement("aside"), text = document.createElement("span"), retry = document.createElement("button");
      node.className = "manga-chapter-feedback";
      node.tabIndex = -1;
      text.tabIndex = 0;
      retry.type = "button";
      retry.dataset.action = "retry-chapter";
      retry.textContent = "重试本话";
      retry.hidden = true;
      retry.addEventListener("click", () => {
        const pending = chapterRead;
        if (!node.isConnected || !currentChapterSource(view) || pending?.view !== view
            || pending.phase !== "failed" || !readerRequestCurrent(pending.owner)) return;
        const target = state.manga.comic.chapters?.find(item => Number(item.index) === Number(pending.index));
        if (!chapterAvailable(target)) return;
        void openChapter(pending.index, pending.options);
      });
      node.append(text, retry);
      view.feedback = node;
      (view.page.querySelector(".manga-reader-floating") || view.page).append(node);
    }
    const chapter = state.manga.comic.chapters?.find(item => Number(item.index) === Number(read.index));
    const target = chapter?.title || `第 ${read.index} 话`, message = busy ? `正在读取 ${target}…` : `${target} 读取失败：${read.message}`;
    const node = view.feedback;
    node.setAttribute("role", busy ? "status" : "alert");
    node.setAttribute("aria-busy", String(busy));
    if (node.firstElementChild.textContent !== message) node.firstElementChild.textContent = message;
    const retry = node.lastElementChild;
    if (!busy) retry.hidden = false;
    retry.textContent = busy ? "正在读取" : "重试本话";
    retry.disabled = !chapterAvailable(chapter);
    setChapterButtonBusy(retry, busy);
  }

  function renderStats() {
    if (els.statsRow) els.statsRow.innerHTML = "";
  }

  function renderView(options = {}) {
    ensureState();
    if (!state.manga.chapter && !state.manga.comic && refreshLibraryKeepingControls()) { syncLibraryComicFeedback(); return; }
    if (!state.manga.chapter && state.manga.comic && refreshDetailKeepingCatalog()) { syncChapterReadFeedback(); return; }
    clearLibraryView();
    stopReaderPosition();
    readerView = null;
    els.workGrid.innerHTML = "";
    els.workGrid.className = "work-grid manga-workspace";
    if (state.manga.chapter && state.manga.comic) {
      const page = renderReader();
      els.workGrid.append(page);
      if (!state.manga.loading) {
        const position = Object.hasOwn(options, "position") ? options.position : readingPositionFor(state.manga.comic.id, state.manga.chapter.index);
        readerPosition = trackReaderPosition(page, position);
      }
    } else if (state.manga.comic) {
      els.workGrid.append(renderDetail());
    } else {
      els.workGrid.append(renderLibrary());
    }
    syncChapterReadFeedback();
    if (state.manga.loading && currentReaderView(readerView) && chapterRead?.view === readerView && !readerPosition) {
      readerPosition = trackReaderPosition(readerView.page, null, { keepScroll: true });
    }
  }

  function refreshLibraryKeepingControls() {
    const current = els.workGrid.querySelector(".manga-library");
    const controls = current?.querySelector(".manga-library-controls");
    const view = libraryView;
    if (!controls || !currentLibraryView(view) || view.page !== current) return false;
    const comics = filteredComics();
    const next = renderLibrary({ includeCards: false, comics });
    const children = [...next.children];
    const replacement = next.querySelector(".manga-library-controls");
    const retained = new Map([[replacement, controls]]);
    const add = current.querySelector(".manga-add-panel"), nextAdd = next.querySelector(".manga-add-panel");
    if (add?.dataset.addViewKey && add.dataset.addViewKey === nextAdd?.dataset.addViewKey) retained.set(nextAdd, add);
    const nextGrid = next.querySelector(".manga-card-grid");
    if (nextGrid) {
      if (view.grid?.parentElement === current) retained.set(nextGrid, view.grid);
      else view.grid = nextGrid;
      updateLibraryCards(view, comics);
    } else {
      view.cards.clear();
      view.grid = null;
    }
    // Keep the whole live form/ancestor chain connected. Even a temporary move
    // would blur a native select or interrupt an active IME composition.
    const keep = new Set(retained.values());
    for (const child of [...current.children]) if (!keep.has(child)) child.remove();
    let cursor = current.firstChild;
    for (const child of children) {
      const live = retained.get(child);
      if (live) cursor = live.nextSibling;
      else current.insertBefore(child, cursor);
    }
    controls.querySelector("select").value = state.manga.sort;
    return true;
  }

  function renderLibrary({ includeCards = true, comics = filteredComics() } = {}) {
    const page = document.createElement("div");
    page.className = "manga-library";
    page.dataset.readerGeneration = String(readerGeneration);
    const view = includeCards ? { page, generation: readerGeneration, grid: null, cards: new Map() } : null;
    if (view) libraryView = view;
    page.append(renderMangaHeader("library"));

    const hero = document.createElement("section");
    hero.className = "manga-library-hero";
    hero.innerHTML = `
      <div>
        <p class="manga-kicker">LOCAL COMIC LIBRARY</p>
        <h1>把漫画当作一本书来管理</h1>
        <p>封面、作品资料、章节目录与下载统一归档，阅读器只在选中章节后打开。</p>
      </div>
      <div class="manga-hero-count"><strong>${formatNumber(state.manga.data?.comics?.length || 0)}</strong><span>本地作品</span></div>
    `;
    page.append(hero);

    const controls = document.createElement("form");
    controls.className = "manga-library-controls";
    const current = () => page.isConnected && state.activeView === "manga" && !state.manga.comic && !state.manga.chapter
      && page.dataset.readerGeneration === String(readerGeneration);
    controls.innerHTML = `
      <label class="manga-search"><span>搜索</span><input type="search" value="${escapeAttr(state.manga.query)}" placeholder="书名、作者、标签" autocomplete="off"></label>
      <label class="manga-sort"><span>排序</span><select><option value="updated">最近更新</option><option value="title">书名</option><option value="chapters">章节最多</option></select></label>
      <button type="submit">查找漫画</button>
      <button class="manga-add-toggle" type="button" data-action="add">添加漫画</button>
    `;
    controls.querySelector("select").value = state.manga.sort;
    controls.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!current()) return;
      retireLibraryComicRead();
      state.manga.query = controls.querySelector("input").value.trim();
      state.manga.sort = controls.querySelector("select").value;
      renderView();
      pushRoute({ mangaQuery: state.manga.query, mangaSort: state.manga.sort });
    });
    controls.querySelector("select").addEventListener("change", () => {
      if (!current()) return;
      retireLibraryComicRead();
      state.manga.sort = controls.querySelector("select").value;
      renderView();
      pushRoute({ mangaSort: state.manga.sort });
    });
    controls.querySelector('[data-action="add"]').addEventListener("click", () => {
      if (!current()) return;
      state.manga.addOpen = true;
      renderView();
      document.querySelector(".manga-add-panel input")?.focus();
    });
    page.append(controls);

    if (state.manga.addOpen || state.manga.addJob) {
      const addPanel = document.createElement("form");
      addPanel.className = "manga-add-panel";
      const addRunning = isUpdateRunning(state.manga.addJob);
      const addedComic = state.manga.data?.comics?.find((comic) => comic.id === state.manga.addJob?.comicId);
      const progress = jobProgressMarkup(state.manga.addJob);
      if (!addRunning) addPanel.dataset.addViewKey = JSON.stringify([state.manga.addUrl, state.manga.addJob?.id || "", progress, state.manga.addError, addedComic?.id || ""]);
      const currentAdd = () => addPanel.isConnected && currentLibraryView(libraryView)
        && addPanel.closest(".manga-library") === libraryView.page && libraryView.page.querySelector(".manga-add-panel") === addPanel;
      addPanel.innerHTML = `
        <div class="manga-add-panel-head"><div><p class="manga-kicker">ADD TO LIBRARY</p><h2>添加新的漫画</h2></div><button type="button" data-action="close" ${addRunning ? "disabled" : ""}>关闭</button></div>
        <label><span>作品链接</span><input type="url" value="${escapeAttr(state.manga.addUrl)}" placeholder="粘贴 smtt6、jmd9/91jmd 或 55comic 作品链接" required ${addRunning ? "disabled" : ""}></label>
        <div class="manga-add-actions"><button class="manga-primary" type="submit" ${addRunning ? "disabled" : ""}>${state.manga.addJob?.status === "failed" ? "重新添加" : "开始采集"}</button>${addedComic ? '<button class="manga-catalog-button" type="button" data-action="catalog">查看目录</button>' : ""}<small>重复链接会转为增量更新，不会建立重复作品。</small></div>
        ${progress}
        ${state.manga.addError ? `<p class="manga-delete-error" role="alert">${escapeHtml(state.manga.addError)}</p>` : ""}
      `;
      addPanel.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!currentAdd()) return;
        void startAddComic(addPanel.querySelector("input").value);
      });
      addPanel.querySelector('[data-action="close"]').addEventListener("click", () => {
        if (!currentAdd()) return;
        state.manga.addOpen = false;
        state.manga.addJob = null;
        state.manga.addError = "";
        renderView();
      });
      addPanel.querySelector('[data-action="catalog"]')?.addEventListener("click", () => { if (currentAdd()) void openComic(addedComic.id); });
      page.append(addPanel);
    }

    const status = currentLibraryComicRead() ? null : renderStatus();
    if (status) page.append(status);
    if (comics.length) {
      const grid = document.createElement("div");
      grid.className = "manga-card-grid";
      if (view) {
        view.grid = grid;
        updateLibraryCards(view, comics);
      }
      page.append(grid);
    } else if (!state.manga.loading) {
      const empty = document.createElement("div");
      empty.className = "manga-empty";
      empty.innerHTML = `<strong>没有匹配的漫画</strong><span>检查采集器是否已生成 manifest.json 与 manga.sqlite。</span>`;
      page.append(empty);
    }
    return page;
  }

  function currentLibraryView(view) {
    return Boolean(view && libraryView === view && view.page.isConnected && view.page.parentElement === els.workGrid
      && state.activeView === "manga" && !state.manga.comic && !state.manga.chapter
      && view.generation === readerGeneration);
  }

  function updateLibraryCards(view, comics) {
    const ids = new Set(comics.map(comic => String(comic.id)));
    for (const [id, record] of view.cards) if (!ids.has(id)) {
      record.card.remove();
      view.cards.delete(id);
    }
    const wanted = comics.map(comic => {
      const id = String(comic.id);
      let record = view.cards.get(id);
      if (!record) {
        record = renderComicCard(comic, view);
        view.cards.set(id, record);
      } else updateComicCard(record, comic);
      return record.card;
    });
    const anchor = document.activeElement?.closest?.(".manga-card");
    const anchorIndex = wanted.indexOf(anchor);
    // Leave the focused card connected even when new metadata changes its sort
    // position. Moving its siblings around it preserves native keyboard focus.
    let cursor = view.grid.firstChild;
    for (const card of anchorIndex < 0 ? wanted : wanted.slice(0, anchorIndex)) {
      if (card !== cursor) view.grid.insertBefore(card, cursor);
      cursor = card.nextSibling;
    }
    if (anchorIndex >= 0) {
      cursor = anchor.nextSibling;
      for (const card of wanted.slice(anchorIndex + 1)) {
        if (card !== cursor) view.grid.insertBefore(card, cursor);
        cursor = card.nextSibling;
      }
    }
  }

  function renderComicCard(comic, view) {
    const card = document.createElement("article");
    card.className = "manga-card";
    card.dataset.comicId = String(comic.id);
    const cover = coverMarkup(comic, comic.title, { lazy: true });
    card.innerHTML = `
      <button class="manga-card-open" type="button" aria-label="查看《${escapeAttr(comic.title)}》详情">
        <span class="manga-card-cover">${cover}<span class="manga-card-site">${escapeHtml(siteLabel(comic.site))}</span></span>
        <span class="manga-card-body">
          <strong>${escapeHtml(comic.title)}</strong>
          <span>${escapeHtml(comic.author || "作者待补充")}</span>
          <small>${formatNumber(comic.chapterCount)} 话 · ${formatNumber(comic.imageCount)} 张</small>
        </span>
      </button>
    `;
    const button = card.querySelector("button"), body = card.querySelector(".manga-card-body");
    const record = { card, button, cover: card.querySelector(".manga-card-cover"), site: card.querySelector(".manga-card-site"),
      title: body.querySelector("strong"), author: body.querySelector("span"), counts: body.querySelector("small"), coverUrl: String(comic.coverUrl || "") };
    button.addEventListener("click", () => {
      const id = card.dataset.comicId;
      if (!currentLibraryView(view) || view.cards.get(id) !== record || card.parentElement !== view.grid
          || view.grid.parentElement !== view.page) return;
      const current = state.manga.data?.comics?.find(item => String(item.id) === id);
      if (currentLibraryComicRead()?.phase === "pending" && String(libraryComicRead.comicId) === id) return;
      if (current && matchesComicQuery(current, state.manga.query.trim().normalize("NFKC").toLowerCase())) void openComic(current.id, { libraryView: view });
    });
    installCoverFallback(card);
    return record;
  }

  function updateComicCard(record, comic) {
    const title = String(comic.title || ""), label = `查看《${title}》详情`;
    if (record.button.getAttribute("aria-label") !== label) record.button.setAttribute("aria-label", label);
    for (const [node, value] of [[record.title, title], [record.author, String(comic.author || "作者待补充")],
      [record.site, siteLabel(comic.site)], [record.counts, `${formatNumber(comic.chapterCount)} 话 · ${formatNumber(comic.imageCount)} 张`]]) {
      if (node.textContent !== value) node.textContent = value;
    }
    const coverUrl = String(comic.coverUrl || "");
    let image = record.cover.querySelector("img"), placeholder = record.cover.querySelector(".manga-cover-placeholder");
    if (record.coverUrl !== coverUrl) {
      const holder = document.createElement("span");
      holder.innerHTML = coverMarkup(comic, title, { lazy: true });
      const next = holder.firstElementChild;
      (image || placeholder).replaceWith(next);
      record.coverUrl = coverUrl;
      installCoverFallback(record.cover);
      image = record.cover.querySelector("img");
      placeholder = record.cover.querySelector(".manga-cover-placeholder");
    }
    if (image && image.alt !== `《${title}》封面`) image.alt = `《${title}》封面`;
    const caption = placeholder?.querySelector("small");
    if (caption && caption.textContent !== title) caption.textContent = title;
  }

  function renderDetailHero(comic) {
    const update = comicUpdate(comic.id);
    const updateRunning = isUpdateRunning(update);
    const deleting = state.manga.deletingComicId === comic.id;
    const availableChapters = comic.chapters?.filter(chapterAvailable) || [];
    const wholeDownloadReady = mangaWholeDownloadReady(comic);
    const wholeDownloadTitle = Number(comic.failedCount || 0) > 0
      ? `还有 ${formatNumber(comic.failedCount)} 个文件失败，请先更新重试`
      : `已完成 ${formatNumber(comic.doneChapterCount || 0)}/${formatNumber(comic.chapterCount || 0)} 话，完成后可下载整本`;
    const hero = document.createElement("section");
    hero.className = "manga-detail-hero";
    hero.innerHTML = `
      <div class="manga-detail-cover">${coverMarkup(comic, comic.title)}</div>
      <div class="manga-detail-copy">
        <p class="manga-kicker">${escapeHtml(siteLabel(comic.site))} · 本地收藏</p>
        <h1>${escapeHtml(comic.title)}</h1>
        <dl class="manga-meta-list">
          <div><dt>作者</dt><dd>${escapeHtml(comic.author || "未知")}</dd></div>
          <div><dt>分类</dt><dd>${escapeHtml((comic.tags || []).join(" · ") || comic.category || "韩漫")}</dd></div>
          <div><dt>状态</dt><dd>${escapeHtml(comic.status || "本地已收录")}</dd></div>
          <div><dt>地区</dt><dd>${escapeHtml(comic.region || "韩国")}</dd></div>
          <div><dt>更新</dt><dd>${escapeHtml(formatDateTime(comic.updatedAt) || "未知")}</dd></div>
          <div><dt>存储</dt><dd>${formatNumber(availableChapters.length)} / ${formatNumber(comic.chapters?.length || 0)} 章 · ${formatNumber(comic.downloadedCount)} 张</dd></div>
        </dl>
        <p class="manga-synopsis">${escapeHtml(comic.description || "采集器尚未补齐简介。重新采集元数据后，这里会显示作品剧情简介。")}</p>
        <div class="manga-detail-actions">
          <button class="manga-primary" type="button" data-action="read" ${availableChapters.length ? "" : "disabled"}>${availableChapters.length ? (progressFor(comic.id) ? "继续阅读" : "开始阅读") : "等待首章下载"}</button>
          <button class="manga-update-button" type="button" data-action="update" ${updateRunning || !comic.sourceUrl ? "disabled" : ""}>${escapeHtml(updateButtonLabel(update))}</button>
          <button type="button" data-action="favorite">${isFavorite(comic.id) ? "已收藏" : "加入收藏"}</button>
          ${wholeDownloadReady
            ? `<a href="/api/manga/${encodeURIComponent(comic.id)}/download">下载整本</a>`
            : `<button type="button" disabled title="${escapeAttr(wholeDownloadTitle)}" aria-label="${escapeAttr(wholeDownloadTitle)}">整本待完成</button>`}
          ${comic.sourceUrl ? `<a href="${escapeAttr(comic.sourceUrl)}" target="_blank" rel="noreferrer">查看来源</a>` : ""}
          <button class="manga-delete-button" type="button" data-action="delete" ${updateRunning || deleting ? "disabled" : ""}>${deleting ? "正在删除" : "删除漫画"}</button>
        </div>
        ${jobProgressMarkup(update)}
        ${state.manga.deleteError ? `<p class="manga-delete-error" role="alert">${escapeHtml(state.manga.deleteError)}</p>` : ""}
      </div>
    `;
    installCoverFallback(hero);
    const current = () => currentDetailView(detailView) && detailView.page.contains(hero);
    hero.querySelector('[data-action="read"]').addEventListener("click", () => {
      if (!current()) return;
      const chapter = detailReadIndex(state.manga.comic);
      if (chapter) void openChapter(chapter, { restorePosition: true });
    });
    hero.querySelector('[data-action="favorite"]').addEventListener("click", (event) => {
      if (!current()) return;
      toggleFavorite(comic.id);
      event.currentTarget.textContent = isFavorite(comic.id) ? "已收藏" : "加入收藏";
    });
    hero.querySelector('[data-action="update"]').addEventListener("click", () => { if (current()) void startComicUpdate(comic.id); });
    hero.querySelector('[data-action="delete"]').addEventListener("click", () => { if (current()) void deleteComicFromLibrary(state.manga.comic); });
    return hero;
  }

  function renderDetail() {
    const comic = state.manga.comic;
    const page = document.createElement("div");
    page.className = "manga-detail";
    page.append(renderMangaHeader("detail"), renderDetailHero(comic));
    const catalog = document.createElement("section");
    catalog.className = "manga-catalog";
    catalog.innerHTML = `
      <div class="manga-section-head"><div><p class="manga-kicker">CHAPTER DIRECTORY</p><h2>章节目录</h2></div><span>${formatNumber(comic.chapters?.length || 0)} 话</span></div>
    `;
    const form = document.createElement("form");
    form.className = "manga-directory-search";
    form.setAttribute("role", "search");
    const label = document.createElement("label");
    label.textContent = "查找章节";
    const input = document.createElement("input");
    input.type = "search";
    input.className = "manga-directory-search-input";
    input.placeholder = "输入章节标题或话数";
    input.setAttribute("aria-label", "查找漫画章节");
    input.autocomplete = "off";
    label.append(input);
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "manga-directory-search-clear";
    clear.textContent = "清除";
    const count = document.createElement("p");
    count.className = "manga-directory-search-count";
    count.setAttribute("role", "status");
    const empty = document.createElement("p");
    empty.className = "manga-directory-search-empty";
    empty.setAttribute("role", "status");
    empty.textContent = "没有匹配的章节，试试其他标题或话数。";
    empty.hidden = true;
    form.append(label, clear, count);
    const list = document.createElement("div");
    list.className = "manga-chapter-list";
    catalog.append(form, empty, list);
    page.append(catalog);
    const view = { page, catalog, form, input, count, empty, list, rows: new Map(), comicId: comic.id,
      generation: readerGeneration, query: "", composing: false, candidateSubmit: false, observer: null };
    detailView = view;
    const commit = () => {
      if (!currentDetailView(view) || view.composing) return;
      const query = normalizeChapterQuery(input.value);
      if (query === view.query) return;
      view.query = query;
      filterChapterCatalog(view);
    };
    const focusFirst = () => {
      if (!currentDetailView(view) || view.composing) return;
      const first = [...list.children].find(row => !row.hidden && !row.querySelector("button").disabled)?.querySelector("button");
      if (!first) return;
      first.focus({ preventScroll: true });
      first.scrollIntoView({ block: "center", behavior: "instant" });
    };
    input.addEventListener("compositionstart", () => { if (currentDetailView(view)) { view.composing = true; view.candidateSubmit = false; } });
    input.addEventListener("compositionend", () => { view.composing = false; commit(); });
    input.addEventListener("input", commit);
    input.addEventListener("search", commit);
    input.addEventListener("keydown", event => {
      if (!currentDetailView(view) || event.defaultPrevented) return;
      if (view.composing || event.isComposing || event.keyCode === 229) {
        if (event.key === "Enter" || event.keyCode === 229) view.candidateSubmit = true;
        event.stopPropagation();
        return;
      }
      view.candidateSubmit = false;
      if (event.key === "Enter" || event.key === "ArrowDown") { event.preventDefault(); commit(); focusFirst(); }
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!currentDetailView(view) || view.composing) return;
      if (view.candidateSubmit) { view.candidateSubmit = false; return; }
      commit(); focusFirst();
    });
    clear.addEventListener("click", () => {
      if (!currentDetailView(view)) return;
      view.composing = false; view.candidateSubmit = false; input.value = ""; commit();
      input.focus({ preventScroll: true });
    });
    updateChapterCatalog(view);
    if (typeof ResizeObserver === "function") {
      view.observer = new ResizeObserver(() => {
        if (currentDetailView(view)) form.style.top = `${page.querySelector(".manga-header").getBoundingClientRect().height}px`;
      });
      view.observer.observe(page.querySelector(".manga-header"));
    }
    return page;
  }

  function currentDetailView(view) {
    return Boolean(view && detailView === view && view.page.isConnected && els.workGrid.contains(view.page)
      && state.activeView === "manga" && !state.manga.chapter && state.manga.comic?.id === view.comicId && readerGeneration === view.generation);
  }

  function refreshDetailKeepingCatalog() {
    const view = detailView;
    if (!currentDetailView(view)) return false;
    const hero = view.page.querySelector(".manga-detail-hero"), next = renderDetailHero(state.manga.comic);
    const actions = hero.querySelector(".manga-detail-actions"), nextActions = next.querySelector(".manga-detail-actions");
    const key = node => node.dataset.action || node.getAttribute("href");
    const old = new Map([...actions.children].map(node => [key(node), node]));
    const wanted = [...nextActions.children].map(node => {
      const retained = old.get(key(node));
      if (!retained || retained.tagName !== node.tagName) return node;
      retained.textContent = node.textContent;
      retained.className = node.className;
      for (const attribute of ["disabled", "title", "aria-label"]) {
        if (node.hasAttribute(attribute)) retained.setAttribute(attribute, node.getAttribute(attribute));
        else retained.removeAttribute(attribute);
      }
      return retained;
    });
    reconcileChapterNodes(actions, wanted);
    const copy = hero.querySelector(".manga-detail-copy");
    for (const child of [...copy.children]) if (child !== actions) child.remove();
    let cursor = actions;
    for (const child of [...next.querySelector(".manga-detail-copy").children]) {
      if (child === nextActions) cursor = actions.nextSibling;
      else copy.insertBefore(child, cursor);
    }
    const cover = hero.querySelector(".manga-detail-cover"), nextCover = next.querySelector(".manga-detail-cover");
    if (cover.innerHTML !== nextCover.innerHTML) cover.replaceWith(nextCover);
    updateChapterCatalog(view);
    return true;
  }

  function updateChapterCatalog(view) {
    const comic = state.manga.comic;
    const currentChapter = directoryReturn?.comicId === comic.id && directoryReturn.generation === readerGeneration
      ? Number(directoryReturn.chapterIndex) : null;
    const wanted = [];
    for (const chapter of comic.chapters || []) {
      const key = String(Number(chapter.index));
      let record = view.rows.get(key);
      if (!record) {
        const row = document.createElement("article"), button = document.createElement("button");
        row.className = "manga-chapter-row";
        row.dataset.chapterIndex = String(chapter.index);
        button.type = "button";
        button.append(document.createElement("span"), document.createElement("strong"), document.createElement("small"));
        row.append(button);
        record = { row, button, chapter };
        view.rows.set(key, record);
        button.addEventListener("click", () => {
          if (!currentDetailView(view) || view.rows.get(key) !== record || row.hidden) return;
          const current = state.manga.comic.chapters?.find(item => Number(item.index) === Number(key));
          if (chapterAvailable(current)) void openChapter(current.index);
        });
      }
      record.chapter = chapter;
      record.searchText = normalizeChapterQuery(`${chapter.index} ${chapter.title || ""}`);
      const available = chapterAvailable(chapter);
      const { row, button } = record;
      row.classList.toggle("is-pending", !available);
      row.classList.toggle("is-current", Number(chapter.index) === currentChapter);
      button.disabled = !available;
      if (Number(chapter.index) === currentChapter) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
      const texts = [`第 ${String(chapter.index).padStart(3, "0")} 话`, chapter.title || `第 ${chapter.index} 话`, available ? `${formatNumber(chapter.imageCount)} 张` : chapter.status === "failed" ? "下载失败" : "待下载"];
      texts.forEach((text, index) => { if (button.children[index].textContent !== text) button.children[index].textContent = text; });
      let download = row.lastElementChild;
      if (available) {
        if (download.tagName !== "A") { download = document.createElement("a"); row.lastElementChild !== button && row.lastElementChild.remove(); row.append(download); }
        download.href = `/api/manga/${encodeURIComponent(comic.id)}/chapters/${encodeURIComponent(chapter.index)}/download`;
        download.setAttribute("aria-label", `下载${chapter.title || `第 ${chapter.index} 话`}`);
        download.textContent = "下载";
      } else if (download.tagName !== "SPAN") {
        if (download !== button) download.remove();
        const pending = document.createElement("span"); pending.className = "manga-chapter-pending"; pending.textContent = "等待"; row.append(pending);
      }
      wanted.push(row);
    }
    const keep = new Set(wanted);
    for (const [key, record] of view.rows) if (!keep.has(record.row)) view.rows.delete(key);
    reconcileChapterNodes(view.list, wanted);
    view.catalog.querySelector(".manga-section-head > span").textContent = `${formatNumber(wanted.length)} 话`;
    filterChapterCatalog(view);
  }

  function normalizeChapterQuery(value) { return String(value || "").normalize("NFKC").toLocaleLowerCase().trim(); }

  function filterChapterCatalog(view) {
    let matches = 0, currentHidden = false;
    for (const { row, searchText, button } of view.rows.values()) {
      const visible = !view.query || searchText.includes(view.query);
      if (row.hidden !== !visible) row.hidden = !visible;
      if (visible) matches++;
      if (!visible && button.hasAttribute("aria-current")) currentHidden = true;
    }
    const text = `匹配 ${formatNumber(matches)} / 共 ${formatNumber(view.rows.size)} 话${currentHidden ? " · 当前阅读章节不在匹配结果中" : ""}`;
    if (view.count.textContent !== text) view.count.textContent = text;
    if (view.empty.hidden !== (matches > 0)) view.empty.hidden = matches > 0;
  }

  function reconcileChapterNodes(parent, wanted) {
    wanted.forEach((node, index) => { if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null); });
    const keep = new Set(wanted);
    for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  }

  function renderReader() {
    const comic = state.manga.comic;
    const chapter = state.manga.chapter;
    const generation = readerGeneration;
    const { previous, next } = readerChapterNeighbors(comic, chapter);
    const page = document.createElement("div");
    const view = readerView = { page, comicId: comic.id, chapter, generation };
    page.className = `manga-reader${state.manga.fitWidth ? " fit-width" : " original-width"}`;
    page.dataset.comicId = String(comic.id);
    page.dataset.chapterIndex = String(chapter.index);
    page.innerHTML = `
      <header class="manga-reader-bar">
        <div class="manga-reader-identity"><button type="button" data-action="detail">返回目录</button><div><strong>${escapeHtml(comic.title)}</strong><span>${escapeHtml(chapter.title)}</span></div></div>
        <div class="manga-reader-actions">
          <button type="button" data-action="previous" ${chapterAvailable(previous) ? "" : "disabled"}>上一话</button>
          <button type="button" data-action="fit">${state.manga.fitWidth ? "原始宽度" : "适应宽度"}</button>
          <a href="/api/manga/${encodeURIComponent(comic.id)}/chapters/${encodeURIComponent(chapter.index)}/download">下载本话</a>
          <button type="button" data-action="next" ${chapterAvailable(next) ? "" : "disabled"}>下一话</button>
        </div>
      </header>
      <main class="manga-reader-pages"></main>
      <footer class="manga-reader-footer"><button type="button" data-action="previous" ${chapterAvailable(previous) ? "" : "disabled"}>上一话</button><button type="button" data-action="detail">查看目录</button><button type="button" data-action="next" ${chapterAvailable(next) ? "" : "disabled"}>下一话</button></footer>
    `;
    const pages = page.querySelector(".manga-reader-pages");
    pages.tabIndex = -1;
    pages.setAttribute("aria-label", `${comic.title} · ${chapter.title} · 章节图片`);
    const floating = document.createElement("div");
    floating.className = "manga-reader-floating";
    floating.append(readerPageNavigation(page, comic, chapter));
    page.append(floating);
    let compactRecovery;
    const compactRecoveryArea = () => {
      if (!compactRecovery) {
        compactRecovery = document.createElement("aside");
        compactRecovery.className = "manga-reader-recovery";
        compactRecovery.tabIndex = -1;
        compactRecovery.setAttribute("aria-label", "图片加载重试");
        floating.prepend(compactRecovery);
      }
      return compactRecovery;
    };
    for (const [index, image] of (chapter.images || []).entries()) {
      pages.append(createReaderImage(comic, chapter, image, index, compactRecoveryArea));
    }
    page.querySelectorAll('[data-action="detail"]').forEach((button) => button.addEventListener("click", (event) => {
      if (!currentReaderView(view)) return;
      readerPosition?.retain();
      resetReader({ keepComic: true });
      directoryReturn = { comicId: comic.id, chapterIndex: chapter.index, generation: readerGeneration };
      renderView();
      pushRoute({ mangaComicId: comic.id, mangaChapterIndex: "" });
      const target = els.workGrid.querySelector('.manga-catalog [aria-current="true"]');
      if (target) {
        target.closest(".manga-chapter-row").scrollIntoView({ block: "center", behavior: "instant" });
        if (event.detail === 0) {
          const focus = target.disabled ? target.closest(".manga-chapter-row") : target;
          if (focus !== target) focus.tabIndex = -1;
          focus.focus({ preventScroll: true });
        }
      } else window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }));
    for (const action of ["previous", "next"]) page.querySelectorAll(`[data-action="${action}"]`).forEach(button => button.addEventListener("click", () => {
      if (!page.isConnected || state.activeView !== "manga" || state.manga.chapter !== chapter
        || state.manga.comic?.id !== comic.id || state.manga.loading) return;
      const adjacent = readerChapterNeighbors(state.manga.comic, chapter)[action];
      if (chapterAvailable(adjacent)) void openChapter(adjacent.index);
    }));
    const toggleFit = () => {
      if (!page.isConnected || els.workGrid.querySelector(".manga-reader") !== page || state.activeView !== "manga"
          || state.manga.chapter !== chapter || state.manga.comic?.id !== comic.id) return;
      const anchor = readerPosition?.capture(readerTopInset(page));
      if (anchor) stopReaderPosition();
      state.manga.fitWidth = !state.manga.fitWidth;
      writeStoredFlag("fanhao.manga.fitWidth", state.manga.fitWidth);
      page.classList.toggle("fit-width", state.manga.fitWidth);
      page.classList.toggle("original-width", !state.manga.fitWidth);
      page.querySelector('[data-action="fit"]').textContent = state.manga.fitWidth ? "原始宽度" : "适应宽度";
      page.querySelector('[data-action="fit-floating"]').textContent = state.manga.fitWidth ? "原始宽度" : "适应宽度";
      if (anchor) readerPosition = trackReaderPosition(page, { ...anchor, fitChange: true });
    };
    page.querySelectorAll('[data-action="fit"], [data-action="fit-floating"]').forEach(button => button.addEventListener("click", toggleFit));
    return page;
  }

  function readerPageNavigation(page, comic, chapter) {
    const total = chapter.images?.length || 0, generation = readerGeneration;
    const view = readerView;
    const nav = document.createElement("nav");
    nav.className = "manga-page-navigation";
    nav.setAttribute("aria-label", "章节页码");
    nav.hidden = !total;
    const current = () => currentReaderView(view);
    const form = document.createElement("form");
    form.className = "manga-page-jump";
    form.id = `manga-page-jump-${generation}`;
    form.hidden = true;
    form.noValidate = true;
    const label = document.createElement("label");
    label.textContent = `跳到第几页（1–${total}）`;
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.setAttribute("enterkeyhint", "go");
    label.append(input);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "前往";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    const message = document.createElement("span");
    message.setAttribute("role", "status");
    const indicator = document.createElement("button");
    indicator.type = "button";
    indicator.className = "manga-page-indicator";
    indicator.dataset.page = "1";
    indicator.textContent = `第 1 / ${total} 页`;
    indicator.setAttribute("aria-label", `当前第 1 页，共 ${total} 页，跳转页码`);
    indicator.setAttribute("aria-expanded", "false");
    indicator.setAttribute("aria-controls", form.id);
    const fit = document.createElement("button");
    fit.type = "button";
    fit.className = "manga-page-fit";
    fit.dataset.action = "fit-floating";
    fit.textContent = state.manga.fitWidth ? "原始宽度" : "适应宽度";
    const close = () => {
      if (!current()) return;
      const restoreFocus = form.contains(document.activeElement);
      form.hidden = true;
      indicator.setAttribute("aria-expanded", "false");
      if (restoreFocus) indicator.focus({ preventScroll: true });
    };
    indicator.addEventListener("click", () => {
      if (!current()) return;
      if (!form.hidden) { close(); return; }
      input.value = indicator.dataset.page;
      input.removeAttribute("aria-invalid");
      message.textContent = "";
      form.hidden = false;
      indicator.setAttribute("aria-expanded", "true");
      input.focus({ preventScroll: true });
      input.select();
    });
    let composing = false;
    input.addEventListener("compositionstart", () => { if (current()) composing = true; });
    input.addEventListener("compositionend", () => { composing = false; });
    form.addEventListener("keydown", event => {
      if (!current()) return;
      if (composing || event.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!current() || composing) return;
      const value = input.value.trim(), number = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > total) {
        input.setAttribute("aria-invalid", "true");
        message.textContent = `请输入 1–${total} 之间的整数页码。`;
        input.focus({ preventScroll: true });
        return;
      }
      close();
      stopReaderPosition();
      readerPosition = trackReaderPosition(page, { page: number - 1, ratio: 0, atStart: number === 1, pageJump: true });
    });
    cancel.addEventListener("click", close);
    form.append(label, submit, cancel, message);
    nav.append(form, indicator, fit);
    return nav;
  }

  function readerTopInset(page) {
    const bar = page.querySelector(".manga-reader-bar");
    return getComputedStyle(bar).position === "sticky" ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
  }

  function readerPageAt(figures, top = 0) {
    let start = 0, end = figures.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (figures[middle].getBoundingClientRect().bottom <= top) start = middle + 1;
      else end = middle;
    }
    return Math.min(start, figures.length - 1);
  }

  function trackReaderPosition(page, position, { keepScroll = false } = {}) {
    const comicId = state.manga.comic.id, chapter = state.manga.chapter, view = readerView;
    const figures = [...page.querySelectorAll(".manga-reader-image")];
    const images = figures.map(figure => figure.querySelector("img"));
    if (!figures.length || position?.atStart) position = null;
    const events = new AbortController(), restoreEvents = new AbortController();
    let restoring = Boolean(position), canSave = !position, stopped = false, timer = null, frame = null, settleFrame = null, indicatorFrame = null, observer = null;
    const current = () => !stopped && view?.page === page && currentReaderView(view);
    const indicator = page.querySelector(".manga-page-indicator");
    const updateIndicator = () => {
      if (!current() || !indicator || !figures.length) return;
      const number = readerPageAt(figures, readerTopInset(page) + 1) + 1;
      if (indicator.dataset.page === String(number)) return;
      indicator.dataset.page = String(number);
      indicator.textContent = `第 ${number} / ${figures.length} 页`;
      indicator.setAttribute("aria-label", `当前第 ${number} 页，共 ${figures.length} 页，跳转页码`);
    };
    const queueIndicator = () => {
      if (indicatorFrame != null) return;
      indicatorFrame = window.requestAnimationFrame(() => { indicatorFrame = null; updateIndicator(); });
    };
    const capture = (inset = 0) => {
      if (!current() || !figures.length) return null;
      const index = readerPageAt(figures, inset + 1), rect = figures[index].getBoundingClientRect();
      if (!rect.height) return null;
      return { page: index, ratio: Math.max(0, Math.min(1, (inset - rect.top) / rect.height)),
        atStart: window.scrollY < 1 || index === 0 && rect.top > inset };
    };
    const save = () => {
      if (position?.fitChange && restoring) finishRestore(true);
      if (!current() || restoring || !canSave || !figures.length) return;
      // Manga pages scroll with the document; the inner pages container only pans horizontally.
      const index = readerPageAt(figures), rect = figures[index].getBoundingClientRect();
      if (!rect.height) return;
      writeReadingPosition(comicId, { chapter: Number(chapter.index), page: index,
        ratio: Math.round(Math.max(0, Math.min(1, -rect.top / rect.height)) * 1e6) / 1e6,
        atStart: window.scrollY < 1 || index === 0 && rect.top > 0 });
    };
    const finishRestore = (completed = false) => {
      restoring = false;
      if (completed || position?.fitChange) canSave = true;
      restoreEvents.abort(); observer?.disconnect();
      if (frame != null) window.cancelAnimationFrame(frame);
      if (settleFrame != null) window.cancelAnimationFrame(settleFrame);
      frame = settleFrame = null;
    };
    const stop = () => { finishRestore(); stopped = true; events.abort(); window.clearTimeout(timer); if (indicatorFrame != null) window.cancelAnimationFrame(indicatorFrame); };
    const retain = () => { finishRestore(true); save(); };
    window.addEventListener("scroll", () => {
      queueIndicator();
      if (restoring || state.activeView !== "manga" || !current()) return;
      canSave = true;
      if (timer == null) timer = window.setTimeout(() => { timer = null; save(); }, 250);
    }, { passive: true, signal: events.signal });
    window.addEventListener("pagehide", () => { save(); finishRestore(); }, { signal: events.signal });
    document.addEventListener("visibilitychange", () => { if (document.hidden) save(); }, { signal: events.signal });
    window.addEventListener("resize", queueIndicator, { signal: events.signal });
    page.addEventListener("load", queueIndicator, { capture: true, signal: events.signal });
    page.addEventListener("error", queueIndicator, { capture: true, signal: events.signal });
    updateIndicator();
    if (!position) {
      if (!keepScroll) window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      save();
      return { save, stop, capture, retain };
    }
    const index = Math.min(position.page, figures.length - 1), target = figures[index];
    const apply = () => {
      if (!current() || !restoring || state.activeView !== "manga") return false;
      const rect = target?.getBoundingClientRect();
      // Reaching a zero-height lazy target starts its request; its final ratio
      // can be applied when the image supplies the missing geometry.
      window.scrollTo({ top: window.scrollY + rect.top + rect.height * position.ratio - (position.pageJump || position.fitChange ? readerTopInset(page) : 0), left: 0, behavior: "auto" });
      return true;
    };
    const geometryReady = () => images.slice(0, index + 1).every((image, offset) =>
      Number(image.getAttribute("width")) > 0 && Number(image.getAttribute("height")) > 0
      || image.complete && (image.naturalWidth > 0 || figures[offset].classList.contains("load-failed")));
    const queueRestore = () => {
      if (!restoring || frame != null) return;
      if (settleFrame != null) window.cancelAnimationFrame(settleFrame);
      settleFrame = null;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (!current()) { finishRestore(); return; }
        if (apply() && geometryReady()) settleFrame = window.requestAnimationFrame(() => { if (!current() || !restoring) return; apply(); finishRestore(true); save(); });
      });
    };
    const cancelForIntent = event => {
      if (event.type === "focusin" && event.target === document.body) return;
      finishRestore();
    };
    for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "focusin"]) {
      document.addEventListener(type, cancelForIntent, { capture: true, passive: true, signal: restoreEvents.signal });
    }
    page.addEventListener("load", queueRestore, { capture: true, signal: restoreEvents.signal });
    page.addEventListener("error", queueRestore, { capture: true, signal: restoreEvents.signal });
    window.addEventListener("resize", queueRestore, { signal: restoreEvents.signal });
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(queueRestore);
      observer.observe(page.querySelector(".manga-reader-pages"));
    }
    // Correct a width change before the next paint can expose distant pages at
    // the old document offset; later geometry uses the same cancellable session.
    if (position.fitChange) apply();
    queueRestore();
    return { save, stop, capture, retain };
  }

  function createReaderImage(comic, chapter, image, index, compactRecoveryArea) {
    const figure = document.createElement("figure");
    figure.className = "manga-reader-image";
    figure.tabIndex = -1;
    const img = document.createElement("img");
    const width = Number(image.width);
    const height = Number(image.height);
    let compactFailure = false;
    if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
      // Reserve the page before decoding so distant pages remain lazy.
      img.width = width;
      img.height = height;
      img.style.setProperty("--manga-original-width", `${width}px`);
      compactFailure = height < 60 || height / width < .25;
    }
    img.alt = `${comic.title} · ${chapter.title} · 第 ${index + 1} 页`;
    img.loading = index < 2 ? "eager" : "lazy";
    img.decoding = "async";
    figure.setAttribute("aria-label", img.alt);
    const retryLabel = `重试第 ${index + 1} 页`;
    let failure, message, retry;
    let retrying = false;
    const current = () => figure.isConnected && state.activeView === "manga" && state.manga.chapter === chapter;
    const ownsRecoveryFocus = () => compactFailure && failure
      && (failure.contains(document.activeElement) || document.activeElement === compactRecoveryArea());
    const focusRecoveryControl = control => {
      control.focus({ preventScroll: true });
      const area = compactRecoveryArea(), box = control.getBoundingClientRect(), bounds = area.getBoundingClientRect();
      if (box.top < bounds.top + 8) area.scrollTop += box.top - bounds.top - 8;
      else if (box.bottom > bounds.bottom - 8) area.scrollTop += box.bottom - bounds.bottom + 8;
    };
    const finishRecoveryFocus = () => {
      const area = compactRecoveryArea();
      const rows = [...area.children], position = rows.indexOf(failure);
      const candidates = [...rows.slice(position + 1), ...rows.slice(0, position).reverse()];
      const next = candidates.filter(row => !row.hidden).map(row => row.querySelector("button:not(:disabled)")).find(Boolean);
      if (next) focusRecoveryControl(next);
      else if (rows.some(row => !row.hidden)) area.focus({ preventScroll: true });
      else figure.closest(".manga-reader")?.querySelector(".manga-reader-pages")?.focus({ preventScroll: true });
    };
    img.addEventListener("error", () => {
      if (!current() || !img.complete || img.naturalWidth) return;
      const returnFocus = ownsRecoveryFocus();
      if (!failure) {
        // Most pages never fail; long chapters need no hidden retry controls.
        failure = document.createElement(compactFailure ? "div" : "figcaption");
        failure.className = "manga-reader-image-error";
        if (compactFailure) failure.tabIndex = -1;
        message = document.createElement("span");
        message.setAttribute("role", "status");
        retry = document.createElement("button");
        retry.type = "button";
        retry.addEventListener("click", () => {
          if (!current() || retrying) return;
          retrying = true;
          if (document.activeElement === retry) (compactFailure ? failure : figure).focus({ preventScroll: true });
          retry.disabled = true;
          retry.textContent = "正在重试…";
          message.textContent = `正在重新加载第 ${index + 1} 页`;
          figure.setAttribute("aria-busy", "true");
          // Retry this page only; decoded neighbours and the chapter stay mounted.
          img.removeAttribute("src");
          img.src = image.url;
        });
        failure.append(message, retry);
        // Tiny rows cannot hold separate 44px targets without overlapping.
        (compactFailure ? compactRecoveryArea() : figure).append(failure);
      }
      retrying = false;
      figure.classList.add("load-failed");
      figure.removeAttribute("aria-busy");
      failure.hidden = false;
      message.textContent = `第 ${index + 1} 页加载失败`;
      retry.disabled = false;
      retry.textContent = retryLabel;
      if (returnFocus) focusRecoveryControl(retry);
    });
    img.addEventListener("load", () => {
      if (!current() || !img.complete || !img.naturalWidth) return;
      img.style.setProperty("--manga-original-width", `${img.naturalWidth}px`);
      if (!failure) return;
      const returnFocus = ownsRecoveryFocus();
      retrying = false;
      figure.classList.remove("load-failed");
      figure.removeAttribute("aria-busy");
      failure.hidden = true;
      retry.disabled = false;
      retry.textContent = retryLabel;
      if (returnFocus) finishRecoveryFocus();
    });
    figure.append(img);
    img.src = image.url;
    return figure;
  }

  function renderMangaHeader(active) {
    const header = document.createElement("header");
    header.className = "manga-header";
    header.innerHTML = `
      <a class="manga-brand" href="/manga"><span>FH</span><strong>漫画馆<small>MANGA LIBRARY</small></strong></a>
      <nav aria-label="漫画导航"><a class="${active === "library" ? "active" : ""}" href="/manga">书库</a><a href="/photo/collections">套图</a></nav>
      <div class="manga-header-meta">独立数据 · 本地阅读</div>
    `;
    return header;
  }

  function matchesComicQuery(comic, query) {
    if (!query) return true;
    return [comic.title, comic.author, comic.description, ...(comic.tags || [])].join(" ").normalize("NFKC").toLowerCase().includes(query);
  }

  function filteredComics() {
    const query = state.manga.query.trim().normalize("NFKC").toLowerCase();
    const list = [...(state.manga.data?.comics || [])].filter(comic => matchesComicQuery(comic, query));
    list.sort((a, b) => {
      if (state.manga.sort === "title") return String(a.title).localeCompare(String(b.title), "zh-CN");
      if (state.manga.sort === "chapters") return Number(b.chapterCount || 0) - Number(a.chapterCount || 0);
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    return list;
  }

  function renderStatus() {
    if (!state.manga.loading && !state.manga.status) return null;
    const node = document.createElement("div");
    node.className = "manga-status";
    node.textContent = state.manga.status || "正在加载";
    return node;
  }

  return { applyRouteState, enter, openRouteTarget, renderStats, renderView, resetReader };
}

function coverMarkup(comic, title, { lazy = false } = {}) {
  return comic.coverUrl
    ? `<img${lazy ? ' loading="lazy" decoding="async"' : ""} src="${escapeAttr(comic.coverUrl)}" alt="《${escapeAttr(title)}》封面" referrerpolicy="no-referrer">`
    : `<span class="manga-cover-placeholder"><b>漫画</b><small>${escapeHtml(title)}</small></span>`;
}

function installCoverFallback(root) {
  root.querySelectorAll("img").forEach((image) => image.addEventListener("error", () => {
    const placeholder = document.createElement("span");
    placeholder.className = "manga-cover-placeholder";
    placeholder.innerHTML = `<b>漫画</b><small>${escapeHtml(image.alt.replace(/^《|》封面$/g, ""))}</small>`;
    image.replaceWith(placeholder);
  }, { once: true }));
}

function readJsonStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "") || fallback; } catch { return fallback; }
}

function favoriteIds() {
  return new Set(readJsonStorage(FAVORITES_KEY, []));
}

function isFavorite(id) {
  return favoriteIds().has(String(id));
}

function toggleFavorite(id) {
  const values = favoriteIds();
  if (values.has(String(id))) values.delete(String(id)); else values.add(String(id));
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...values]));
}

function progressFor(id) {
  return Number(readJsonStorage(PROGRESS_KEY, {})[id] || 0);
}

function readingPositionFor(id, chapterIndex) {
  const value = readJsonStorage(POSITION_KEY, {})[id];
  return value && Number(value.chapter) === Number(chapterIndex) && Number.isInteger(value.page) && value.page >= 0
    && Number.isFinite(value.ratio) && value.ratio >= 0 && value.ratio <= 1 ? value : null;
}

function writeReadingPosition(id, position) {
  try {
    const data = readJsonStorage(POSITION_KEY, {});
    if (JSON.stringify(data[id]) === JSON.stringify(position)) return;
    data[id] = position;
    localStorage.setItem(POSITION_KEY, JSON.stringify(data));
  } catch { /* Local position saving must not interrupt reading. */ }
}

function saveProgress(id, chapterIndex) {
  const data = readJsonStorage(PROGRESS_KEY, {});
  data[id] = Number(chapterIndex || 0);
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(data));
}

function forgetComicState(id) {
  const favorites = favoriteIds();
  favorites.delete(String(id));
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
  const progress = readJsonStorage(PROGRESS_KEY, {});
  delete progress[id];
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  try {
    const positions = readJsonStorage(POSITION_KEY, {});
    delete positions[id];
    localStorage.setItem(POSITION_KEY, JSON.stringify(positions));
  } catch { /* The comic is already removed even if local storage is unavailable. */ }
}

function siteLabel(site) {
  return String(site || "local").toUpperCase();
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
