const FAVORITES_KEY = "fanhao.manga.favorites";
const PROGRESS_KEY = "fanhao.manga.progress";

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
    if (!options.deferInitialLoad && !state.manga.data) void loadLibrary();
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route = {}) {
    ensureState();
    state.manga.query = route.mangaQuery || "";
    state.manga.sort = ["updated", "title", "chapters"].includes(route.mangaSort) ? route.mangaSort : "updated";
  }

  async function openRouteTarget(route = {}) {
    ensureState();
    if (route.mangaComicId && route.mangaChapterIndex) {
      await openComic(route.mangaComicId, { skipRoute: true, render: false });
      await openChapter(route.mangaChapterIndex, { skipRoute: true });
      return;
    }
    if (route.mangaComicId) {
      await openComic(route.mangaComicId, { skipRoute: true });
      return;
    }
    state.manga.comic = null;
    state.manga.chapter = null;
    await loadLibrary({ skipRoute: true });
  }

  async function loadLibrary(options = {}) {
    state.manga.loading = true;
    state.manga.status = "正在读取漫画书库";
    renderView();
    try {
      state.manga.data = await api("/api/manga");
      state.manga.status = "";
    } catch (error) {
      state.manga.status = error.message || "漫画书库读取失败";
    } finally {
      state.manga.loading = false;
      renderView();
      if (!options.skipRoute) syncRouteAfterNavigation(options);
    }
  }

  async function openComic(comicId, options = {}) {
    state.manga.loading = true;
    state.manga.status = "正在读取作品资料和目录";
    if (options.render !== false) renderView();
    try {
      const data = await api(`/api/manga/${encodeURIComponent(comicId)}`);
      state.manga.comic = data.comic;
      state.manga.updates[comicId] = data.update || { status: "idle" };
      state.manga.chapter = null;
      state.manga.status = "";
      if (options.render !== false) renderView();
      syncRouteAfterNavigation(options);
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      if (data.update?.status === "running") void watchComicUpdate(comicId);
    } catch (error) {
      state.manga.status = error.message || "漫画详情读取失败";
      renderView();
    } finally {
      state.manga.loading = false;
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
    renderView();
    try {
      const result = await api(`/api/manga/${encodeURIComponent(comicId)}/update`, { method: "POST" });
      state.manga.updates[comicId] = result.job || { status: "running" };
      renderView();
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
      renderView();
    }
  }

  function watchComicUpdate(comicId) {
    if (updatePolls.has(comicId)) return updatePolls.get(comicId);
    const polling = (async () => {
      while (isUpdateRunning(comicUpdate(comicId))) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        const data = await api(`/api/manga/${encodeURIComponent(comicId)}/update`);
        state.manga.updates[comicId] = data.job || { status: "idle" };
        if (state.manga.comic?.id === comicId) renderView();
      }
      const job = comicUpdate(comicId);
      if (job.status === "complete") await refreshComicAfterUpdate(comicId, job);
      return job;
    })().catch((error) => {
      state.manga.updates[comicId] = {
        status: "failed",
        message: error.message || "漫画更新状态读取失败"
      };
      if (state.manga.comic?.id === comicId) renderView();
      return state.manga.updates[comicId];
    }).finally(() => updatePolls.delete(comicId));
    updatePolls.set(comicId, polling);
    return polling;
  }

  async function refreshComicAfterUpdate(comicId, finishedJob) {
    const [detail, library] = await Promise.all([
      api(`/api/manga/${encodeURIComponent(comicId)}`),
      api("/api/manga")
    ]);
    state.manga.data = library;
    state.manga.updates[comicId] = detail.update?.status === "running"
      ? detail.update
      : finishedJob;
    if (state.manga.comic?.id === comicId) {
      state.manga.comic = detail.comic;
      state.manga.chapter = null;
      renderView();
    }
  }

  async function startAddComic(url) {
    const value = String(url || "").trim();
    if (!value || isUpdateRunning(state.manga.addJob)) return;
    state.manga.addUrl = value;
    state.manga.addError = "";
    state.manga.addCatalogSyncedJobId = "";
    state.manga.addJob = { status: "starting", message: "正在启动漫画采集", progressPercent: 1 };
    renderView();
    try {
      const result = await api("/api/manga/add", { method: "POST", body: { url: value } });
      state.manga.addJob = result.job;
      renderView();
      if (isUpdateRunning(result.job)) void watchAddJob(result.job.id);
      else if (result.job?.status === "complete") await refreshLibraryAfterAdd();
    } catch (error) {
      state.manga.addJob = { status: "failed", message: error.message || "漫画添加失败" };
      state.manga.addError = error.message || "漫画添加失败";
      renderView();
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
          const library = await api("/api/manga");
          state.manga.data = library;
          if (library.comics?.some((comic) => comic.id === data.job.comicId)) {
            state.manga.addCatalogSyncedJobId = jobId;
          }
        }
        if (!state.manga.comic) renderView();
      }
      if (state.manga.addJob?.status === "complete") await refreshLibraryAfterAdd();
      return state.manga.addJob;
    })().catch((error) => {
      state.manga.addJob = { status: "failed", message: error.message || "漫画采集状态读取失败" };
      state.manga.addError = state.manga.addJob.message;
      if (!state.manga.comic) renderView();
      return state.manga.addJob;
    }).finally(() => updatePolls.delete(pollKey));
    updatePolls.set(pollKey, polling);
    return polling;
  }

  async function refreshLibraryAfterAdd() {
    state.manga.data = await api("/api/manga");
    state.manga.status = "";
    if (!state.manga.comic) renderView();
  }

  async function deleteComicFromLibrary(comic) {
    if (!comic?.id || state.manga.deletingComicId || isUpdateRunning(comicUpdate(comic.id))) return;
    const confirmed = window.confirm(
      `确定删除《${comic.title}》吗？\n\n整本漫画会移入本地回收区，并从自动采集列表移除。`
    );
    if (!confirmed) return;
    state.manga.deletingComicId = comic.id;
    state.manga.deleteError = "";
    state.manga.status = "正在把漫画移入回收区";
    renderView();
    try {
      await api(`/api/manga/${encodeURIComponent(comic.id)}`, { method: "DELETE" });
      if (state.manga.data?.comics) {
        state.manga.data.comics = state.manga.data.comics.filter((item) => item.id !== comic.id);
      }
      delete state.manga.updates[comic.id];
      forgetComicState(comic.id);
      state.manga.comic = null;
      state.manga.chapter = null;
      state.manga.status = `《${comic.title}》已移入回收区`;
      renderView();
      pushRoute({ mangaComicId: "", mangaChapterIndex: "" });
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch (error) {
      state.manga.deleteError = error.message || "漫画删除失败";
    } finally {
      state.manga.deletingComicId = "";
      if (state.manga.comic?.id === comic.id) renderView();
    }
  }

  async function openChapter(chapterIndex, options = {}) {
    const comic = state.manga.comic;
    if (!comic) return;
    state.manga.loading = true;
    state.manga.status = "正在读取章节";
    renderView();
    try {
      const data = await api(`/api/manga/${encodeURIComponent(comic.id)}/chapters/${encodeURIComponent(String(chapterIndex))}`);
      state.manga.comic = { ...comic, ...(data.comic || {}) };
      state.manga.chapter = { ...data.chapter, comicId: comic.id };
      state.manga.status = "";
      saveProgress(comic.id, data.chapter?.index);
      renderView();
      syncRouteAfterNavigation(options);
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    } catch (error) {
      state.manga.status = error.message || "章节读取失败";
      renderView();
    } finally {
      state.manga.loading = false;
    }
  }

  function renderStats() {
    if (els.statsRow) els.statsRow.innerHTML = "";
  }

  function renderView() {
    ensureState();
    els.workGrid.innerHTML = "";
    els.workGrid.className = "work-grid manga-workspace";
    if (state.manga.chapter && state.manga.comic) {
      els.workGrid.append(renderReader());
    } else if (state.manga.comic) {
      els.workGrid.append(renderDetail());
    } else {
      els.workGrid.append(renderLibrary());
    }
  }

  function renderLibrary() {
    const page = document.createElement("div");
    page.className = "manga-library";
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
    controls.innerHTML = `
      <label class="manga-search"><span>搜索</span><input type="search" value="${escapeAttr(state.manga.query)}" placeholder="书名、作者、标签" autocomplete="off"></label>
      <label class="manga-sort"><span>排序</span><select><option value="updated">最近更新</option><option value="title">书名</option><option value="chapters">章节最多</option></select></label>
      <button type="submit">查找漫画</button>
      <button class="manga-add-toggle" type="button" data-action="add">添加漫画</button>
    `;
    controls.querySelector("select").value = state.manga.sort;
    controls.addEventListener("submit", (event) => {
      event.preventDefault();
      state.manga.query = controls.querySelector("input").value.trim();
      state.manga.sort = controls.querySelector("select").value;
      renderView();
      pushRoute({ mangaQuery: state.manga.query, mangaSort: state.manga.sort });
    });
    controls.querySelector("select").addEventListener("change", () => {
      state.manga.sort = controls.querySelector("select").value;
      renderView();
      pushRoute({ mangaSort: state.manga.sort });
    });
    controls.querySelector('[data-action="add"]').addEventListener("click", () => {
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
      addPanel.innerHTML = `
        <div class="manga-add-panel-head"><div><p class="manga-kicker">ADD TO LIBRARY</p><h2>添加新的漫画</h2></div><button type="button" data-action="close" ${addRunning ? "disabled" : ""}>关闭</button></div>
        <label><span>作品链接</span><input type="url" value="${escapeAttr(state.manga.addUrl)}" placeholder="粘贴 smtt6、jmd9/91jmd 或 55comic 作品链接" required ${addRunning ? "disabled" : ""}></label>
        <div class="manga-add-actions"><button class="manga-primary" type="submit" ${addRunning ? "disabled" : ""}>${state.manga.addJob?.status === "failed" ? "重新添加" : "开始采集"}</button>${addedComic ? '<button class="manga-catalog-button" type="button" data-action="catalog">查看目录</button>' : ""}<small>重复链接会转为增量更新，不会建立重复作品。</small></div>
        ${jobProgressMarkup(state.manga.addJob)}
        ${state.manga.addError ? `<p class="manga-delete-error" role="alert">${escapeHtml(state.manga.addError)}</p>` : ""}
      `;
      addPanel.addEventListener("submit", (event) => {
        event.preventDefault();
        void startAddComic(addPanel.querySelector("input").value);
      });
      addPanel.querySelector('[data-action="close"]').addEventListener("click", () => {
        state.manga.addOpen = false;
        state.manga.addJob = null;
        state.manga.addError = "";
        renderView();
      });
      addPanel.querySelector('[data-action="catalog"]')?.addEventListener("click", () => void openComic(addedComic.id));
      page.append(addPanel);
    }

    const status = renderStatus();
    if (status) page.append(status);
    const comics = filteredComics();
    if (comics.length) {
      const grid = document.createElement("div");
      grid.className = "manga-card-grid";
      comics.forEach((comic) => grid.append(renderComicCard(comic)));
      page.append(grid);
    } else if (!state.manga.loading) {
      const empty = document.createElement("div");
      empty.className = "manga-empty";
      empty.innerHTML = `<strong>没有匹配的漫画</strong><span>检查采集器是否已生成 manifest.json 与 manga.sqlite。</span>`;
      page.append(empty);
    }
    return page;
  }

  function renderComicCard(comic) {
    const card = document.createElement("article");
    card.className = "manga-card";
    const cover = coverMarkup(comic, comic.title);
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
    card.querySelector("button").addEventListener("click", () => void openComic(comic.id));
    installCoverFallback(card);
    return card;
  }

  function renderDetail() {
    const comic = state.manga.comic;
    const update = comicUpdate(comic.id);
    const updateRunning = isUpdateRunning(update);
    const deleting = state.manga.deletingComicId === comic.id;
    const availableChapters = comic.chapters?.filter(chapterAvailable) || [];
    const wholeDownloadReady = mangaWholeDownloadReady(comic);
    const wholeDownloadTitle = Number(comic.failedCount || 0) > 0
      ? `还有 ${formatNumber(comic.failedCount)} 个文件失败，请先更新重试`
      : `已完成 ${formatNumber(comic.doneChapterCount || 0)}/${formatNumber(comic.chapterCount || 0)} 话，完成后可下载整本`;
    const page = document.createElement("div");
    page.className = "manga-detail";
    page.append(renderMangaHeader("detail"));

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
    hero.querySelector('[data-action="read"]').addEventListener("click", () => {
      const saved = progressFor(comic.id);
      const chapter = availableChapters.some((item) => item.index === saved) ? saved : availableChapters[0]?.index;
      if (chapter) void openChapter(chapter);
    });
    hero.querySelector('[data-action="favorite"]').addEventListener("click", (event) => {
      toggleFavorite(comic.id);
      event.currentTarget.textContent = isFavorite(comic.id) ? "已收藏" : "加入收藏";
    });
    hero.querySelector('[data-action="update"]').addEventListener("click", () => void startComicUpdate(comic.id));
    hero.querySelector('[data-action="delete"]').addEventListener("click", () => void deleteComicFromLibrary(comic));
    page.append(hero);

    const catalog = document.createElement("section");
    catalog.className = "manga-catalog";
    catalog.innerHTML = `
      <div class="manga-section-head"><div><p class="manga-kicker">CHAPTER DIRECTORY</p><h2>章节目录</h2></div><span>${formatNumber(comic.chapters?.length || 0)} 话</span></div>
    `;
    const list = document.createElement("div");
    list.className = "manga-chapter-list";
    for (const chapter of comic.chapters || []) {
      const available = chapterAvailable(chapter);
      const row = document.createElement("article");
      row.className = `manga-chapter-row${available ? "" : " is-pending"}`;
      row.innerHTML = `
        <button type="button" ${available ? "" : "disabled"}><span>第 ${String(chapter.index).padStart(3, "0")} 话</span><strong>${escapeHtml(chapter.title || `第 ${chapter.index} 话`)}</strong><small>${available ? `${formatNumber(chapter.imageCount)} 张` : (chapter.status === "failed" ? "下载失败" : "待下载")}</small></button>
        ${available ? `<a href="/api/manga/${encodeURIComponent(comic.id)}/chapters/${encodeURIComponent(chapter.index)}/download" aria-label="下载${escapeAttr(chapter.title)}">下载</a>` : '<span class="manga-chapter-pending">等待</span>'}
      `;
      if (available) row.querySelector("button").addEventListener("click", () => void openChapter(chapter.index));
      list.append(row);
    }
    catalog.append(list);
    page.append(catalog);
    return page;
  }

  function renderReader() {
    const comic = state.manga.comic;
    const chapter = state.manga.chapter;
    const chapters = comic.chapters || [];
    const position = chapters.findIndex((item) => Number(item.index) === Number(chapter.index));
    const previous = position > 0 ? chapters[position - 1] : null;
    const next = position >= 0 && position < chapters.length - 1 ? chapters[position + 1] : null;
    const page = document.createElement("div");
    page.className = `manga-reader${state.manga.fitWidth ? " fit-width" : " original-width"}`;
    page.innerHTML = `
      <header class="manga-reader-bar">
        <div class="manga-reader-identity"><button type="button" data-action="detail">返回目录</button><div><strong>${escapeHtml(comic.title)}</strong><span>${escapeHtml(chapter.title)}</span></div></div>
        <div class="manga-reader-actions">
          <button type="button" data-action="previous" ${previous ? "" : "disabled"}>上一话</button>
          <button type="button" data-action="fit">${state.manga.fitWidth ? "原始宽度" : "适应宽度"}</button>
          <a href="/api/manga/${encodeURIComponent(comic.id)}/chapters/${encodeURIComponent(chapter.index)}/download">下载本话</a>
          <button type="button" data-action="next" ${next ? "" : "disabled"}>下一话</button>
        </div>
      </header>
      <main class="manga-reader-pages"></main>
      <footer class="manga-reader-footer"><button type="button" data-action="previous" ${previous ? "" : "disabled"}>上一话</button><button type="button" data-action="detail">查看目录</button><button type="button" data-action="next" ${next ? "" : "disabled"}>下一话</button></footer>
    `;
    const pages = page.querySelector(".manga-reader-pages");
    for (const [index, image] of (chapter.images || []).entries()) {
      const img = document.createElement("img");
      img.src = image.url;
      img.alt = `${comic.title} · ${chapter.title} · 第 ${index + 1} 页`;
      img.loading = index < 2 ? "eager" : "lazy";
      img.decoding = "async";
      pages.append(img);
    }
    page.querySelectorAll('[data-action="detail"]').forEach((button) => button.addEventListener("click", () => {
      state.manga.chapter = null;
      renderView();
      pushRoute({ mangaComicId: comic.id, mangaChapterIndex: "" });
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }));
    page.querySelectorAll('[data-action="previous"]').forEach((button) => button.addEventListener("click", () => previous && void openChapter(previous.index)));
    page.querySelectorAll('[data-action="next"]').forEach((button) => button.addEventListener("click", () => next && void openChapter(next.index)));
    page.querySelector('[data-action="fit"]').addEventListener("click", () => {
      state.manga.fitWidth = !state.manga.fitWidth;
      writeStoredFlag("fanhao.manga.fitWidth", state.manga.fitWidth);
      renderView();
    });
    return page;
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

  function filteredComics() {
    const query = state.manga.query.trim().toLowerCase();
    const list = [...(state.manga.data?.comics || [])].filter((comic) => {
      if (!query) return true;
      return [comic.title, comic.author, comic.description, ...(comic.tags || [])].join(" ").toLowerCase().includes(query);
    });
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

  return { applyRouteState, enter, openRouteTarget, renderStats, renderView };
}

function coverMarkup(comic, title) {
  return comic.coverUrl
    ? `<img src="${escapeAttr(comic.coverUrl)}" alt="《${escapeAttr(title)}》封面" referrerpolicy="no-referrer">`
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
