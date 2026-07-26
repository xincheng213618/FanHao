const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);
const TASK_HISTORY_PAGE_SIZE = 8;
const TASK_HISTORY_FILTERS = new Set(["all", "failed", "succeeded", "cancelled"]);

export function paginateNovelCollectionHistory(tasks = [], options = {}) {
  const filter = TASK_HISTORY_FILTERS.has(options.filter) ? options.filter : "all";
  const query = String(options.query || "").trim().toLocaleLowerCase();
  const pageSize = Math.max(1, Number(options.pageSize || TASK_HISTORY_PAGE_SIZE));
  const filteredTasks = tasks.filter((task) => {
    if (ACTIVE_STATUSES.has(task.status)) return false;
    if (filter !== "all" && task.status !== filter) return false;
    if (!query) return true;
    return [task.name, task.startUrl, task.adapterName, task.error, task.message]
      .some((value) => String(value || "").toLocaleLowerCase().includes(query));
  });
  const pageCount = Math.max(1, Math.ceil(filteredTasks.length / pageSize));
  const page = Math.max(0, Math.min(pageCount - 1, Number(options.page || 0)));
  const start = page * pageSize;
  return {
    tasks: filteredTasks.slice(start, start + pageSize),
    total: filteredTasks.length,
    page,
    pageCount
  };
}

export function createNovelCollectionAdmin({
  api,
  state,
  formatDateTime,
  formatNumber,
  onLibraryChanged,
  openBook,
  rerender
}) {
  let pollTimer = null;

  function ensureState() {
    if (!state.novel) state.novel = {};
    if (!state.novel.collection) {
      state.novel.collection = {
        loaded: false,
        loading: false,
        error: "",
        notice: "",
        adapters: [],
        tasks: [],
        summary: {},
        credentials: {},
        runtime: {},
        draftUrl: "",
        draftName: "",
        draftAdapterId: "auto",
        submitting: false,
        taskFilter: "all",
        taskPage: 0,
        taskQuery: "",
        taskSearchDraft: "",
        adaptersOpen: false,
        selectedTaskId: "",
        expandedTaskIds: new Set(),
        taskLogViews: new Map(),
        workspaceView: "tasks"
      };
    }
    const collection = state.novel.collection;
    collection.taskFilter = TASK_HISTORY_FILTERS.has(collection.taskFilter) ? collection.taskFilter : "all";
    collection.taskPage = Math.max(0, Number(collection.taskPage || 0));
    collection.taskQuery = String(collection.taskQuery || "");
    collection.taskSearchDraft = String(collection.taskSearchDraft ?? collection.taskQuery);
    collection.adaptersOpen = Boolean(collection.adaptersOpen);
    collection.selectedTaskId = String(collection.selectedTaskId || "");
    if (!(collection.expandedTaskIds instanceof Set)) {
      collection.expandedTaskIds = new Set(Array.isArray(collection.expandedTaskIds) ? collection.expandedTaskIds : []);
    }
    if (!(collection.taskLogViews instanceof Map)) {
      collection.taskLogViews = new Map(Array.isArray(collection.taskLogViews) ? collection.taskLogViews : []);
    }
    collection.workspaceView = collection.workspaceView === "adapters" ? "adapters" : "tasks";
    return collection;
  }

  async function load(options = {}) {
    const collection = ensureState();
    if (collection.loading) return collection;
    collection.loading = true;
    if (!options.silent) rerender();
    try {
      const previous = new Map(collection.tasks.map((task) => [task.id, task]));
      const data = await api("/api/novels/collection");
      collection.adapters = Array.isArray(data.adapters) ? data.adapters : [];
      collection.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      collection.summary = data.summary || {};
      collection.credentials = data.credentials || {};
      collection.runtime = data.runtime || {};
      const currentTaskIds = new Set(collection.tasks.map((task) => String(task.id || "")));
      for (const taskId of collection.expandedTaskIds) {
        if (!currentTaskIds.has(taskId)) collection.expandedTaskIds.delete(taskId);
      }
      for (const taskId of collection.taskLogViews.keys()) {
        if (!currentTaskIds.has(taskId)) collection.taskLogViews.delete(taskId);
      }
      collection.loaded = true;
      collection.error = "";
      if (collection.tasks.some((task) => task.bookId && previous.get(task.id)?.status !== "succeeded" && task.status === "succeeded")) {
        await onLibraryChanged?.();
      }
    } catch (error) {
      collection.error = error.message || "采集后台读取失败";
    } finally {
      collection.loading = false;
    }
    if (!options.silent) rerender();
    schedulePoll();
    return collection;
  }

  function render(options = {}) {
    const collection = ensureState();
    const sectionName = options.section === "config" ? "config" : "collect";
    const root = document.createElement("div");
    root.className = `novel-collection-admin section-${sectionName}`;
    if (!collection.loaded && !collection.loading) {
      queueMicrotask(() => load().catch(() => {}));
    }
    if (collection.error) {
      const error = document.createElement("div");
      error.className = "novel-collection-alert error";
      error.textContent = collection.error;
      root.append(error);
    }
    if (collection.notice) {
      const notice = document.createElement("div");
      notice.className = "novel-collection-alert success";
      notice.textContent = collection.notice;
      root.append(notice);
    }
    if (sectionName === "config") {
      root.append(renderCollectorHeading(collection, { section: "config" }));
      root.append(renderAdapters(collection, { embedded: true }));
    } else {
      collection.workspaceView = "tasks";
      root.append(renderCollectorHeading(collection, { section: "collect" }));
      root.append(renderTasks(collection, { showAdapters: false }));
    }
    schedulePoll();
    return root;
  }

  function renderCollectorHeading(collection, options = {}) {
    const configSection = options.section === "config";
    const head = document.createElement("div");
    head.className = "novel-collection-heading";
    const copy = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = configSection ? "采集设置" : "网页采集";
    const title = document.createElement("h2");
    title.textContent = configSection ? "站点配置" : "采集任务";
    const description = document.createElement("p");
    description.textContent = configSection
      ? "维护站点适配器、登录凭据和采集器运行环境。"
      : "创建网页采集任务，在同一工作区查看队列、进度、断点与日志。";
    copy.append(eyebrow, title, description);
    const controls = document.createElement("div");
    controls.className = "novel-collection-heading-actions";
    const aliceswCredential = collection.credentials?.alicesw || {};
    const credentialButton = actionButton(
      aliceswCredential.configured ? "爱丽丝登录 · 已配置" : "配置爱丽丝登录",
      aliceswCredential.configured ? "secondary" : "primary",
      () => openAliceswCredentialEditor()
    );
    credentialButton.title = aliceswCredential.configured
      ? "Cookie 已保存在本机；点击可覆盖、检测或清除"
      : "配置已登录并通过访问验证的爱丽丝书屋 Cookie";
    const runtime = document.createElement("div");
    runtime.className = `novel-collector-runtime ${collection.runtime?.ready ? "ready" : "unavailable"}`;
    runtime.textContent = collection.runtime?.ready
      ? "采集器可用"
      : `采集器不可用${collection.runtime?.error ? `：${collection.runtime.error}` : ""}`;
    if (configSection) controls.append(credentialButton);
    controls.append(runtime);
    head.append(copy, controls);
    return head;
  }

  function renderCollectorSummary(collection) {
    const summary = document.createElement("div");
    summary.className = "novel-collection-summary";
    const status = collection.summary?.status || {};
    for (const [label, value, tone] of [
      ["任务记录", collection.summary?.tasks || collection.tasks.length, "neutral"],
      ["进行中", collection.summary?.active || 0, "running"],
      ["失败", status.failed || 0, "failed"],
      ["站点适配器", collection.summary?.adapters || collection.adapters.length, "adapter"]
    ]) {
      const item = document.createElement("div");
      item.className = `novel-collection-summary-item ${tone}`;
      const strong = document.createElement("strong");
      strong.textContent = formatNumber(value || 0);
      const span = document.createElement("span");
      span.textContent = label;
      item.append(strong, span);
      summary.append(item);
    }
    return summary;
  }

  function renderQuickTask(collection) {
    const section = document.createElement("section");
    section.className = "novel-collection-workspace-create";
    const head = panelHeading("新建采集任务", "先测试页面结构，再执行完整采集。");
    const form = document.createElement("form");
    form.className = "novel-collection-task-form";
    const urlField = field("网页地址", "url", collection.draftUrl, "https://example.com/book/123");
    urlField.input.required = true;
    urlField.input.addEventListener("input", () => {
      collection.draftUrl = urlField.input.value;
    });
    const nameField = field("任务名称（可选）", "text", collection.draftName, "例如：重新采集某本小说");
    nameField.input.addEventListener("input", () => {
      collection.draftName = nameField.input.value;
    });
    const adapterLabel = document.createElement("label");
    adapterLabel.className = "novel-collection-field";
    const adapterText = document.createElement("span");
    adapterText.textContent = "站点适配器";
    const adapterSelect = document.createElement("select");
    const autoOption = document.createElement("option");
    autoOption.value = "auto";
    autoOption.textContent = "自动识别（推荐）";
    adapterSelect.append(autoOption);
    for (const adapter of collection.adapters) {
      const option = document.createElement("option");
      option.value = adapter.id;
      option.textContent = `${adapter.name}${adapter.system ? " · 内置" : " · 自定义"}`;
      adapterSelect.append(option);
    }
    adapterSelect.value = collection.draftAdapterId || "auto";
    adapterSelect.addEventListener("change", () => {
      collection.draftAdapterId = adapterSelect.value;
    });
    adapterLabel.append(adapterText, adapterSelect);
    const actions = document.createElement("div");
    actions.className = "novel-collection-form-actions";
    const test = actionButton("测试适配", "secondary", () => submitTask("test"));
    const collect = actionButton("开始采集", "primary", () => submitTask("collect"));
    test.disabled = collection.submitting || !collection.runtime?.ready;
    collect.disabled = collection.submitting || !collection.runtime?.ready;
    actions.append(test, collect);
    form.append(urlField.label, nameField.label, adapterLabel, actions);
    form.addEventListener("submit", (event) => event.preventDefault());
    section.append(head, form);
    return section;
  }

  function renderTasks(collection) {
    const section = document.createElement("section");
    section.className = "novel-collection-task-page";
    const activeTasks = collection.tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
    const historyTasks = collection.tasks.filter((task) => !ACTIVE_STATUSES.has(task.status));
    section.append(renderQuickTask(collection));

    const listPanel = document.createElement("section");
    listPanel.className = "novel-collection-panel novel-collection-task-list-panel";
    const listHead = document.createElement("div");
    listHead.className = "novel-collection-task-list-head";
    const listCopy = document.createElement("div");
    const listTitle = document.createElement("h3");
    listTitle.textContent = "任务列表";
    const listDescription = document.createElement("p");
    listDescription.textContent = `共 ${formatNumber(collection.tasks.length)} 条任务记录，运行中任务置顶，历史记录按页显示。`;
    listCopy.append(listTitle, listDescription);
    const listStats = document.createElement("div");
    listStats.className = "novel-collection-task-list-stats";
    for (const [label, value, tone] of [
      ["全部", collection.tasks.length, "all"],
      ["进行中", activeTasks.length, "running"],
      ["失败", historyTasks.filter((task) => task.status === "failed").length, "failed"]
    ]) {
      const stat = document.createElement("span");
      stat.className = tone;
      stat.textContent = `${label} ${formatNumber(value)}`;
      listStats.append(stat);
    }
    const refresh = actionButton(collection.loading ? "刷新中" : "刷新", "ghost", () => load());
    refresh.disabled = collection.loading;
    listStats.append(refresh);
    listHead.append(listCopy, listStats);
    listPanel.append(listHead);

    if (activeTasks.length) {
      const active = document.createElement("section");
      active.className = "novel-collection-task-list-section active";
      const activeTitle = document.createElement("h4");
      activeTitle.textContent = `执行中与队列（${formatNumber(activeTasks.length)}）`;
      const activeList = document.createElement("div");
      activeList.className = "novel-collection-task-list-rows";
      for (const task of activeTasks) activeList.append(renderTaskListItem(task));
      active.append(activeTitle, activeList);
      listPanel.append(active);
    }

    const history = document.createElement("section");
    history.className = "novel-collection-task-list-section novel-collection-history";
    const historyTitle = document.createElement("h4");
    historyTitle.textContent = "历史记录";
    history.append(historyTitle, renderTaskFilters(collection, historyTasks));

    const historyPage = paginateNovelCollectionHistory(historyTasks, {
      filter: collection.taskFilter,
      query: collection.taskQuery,
      page: collection.taskPage,
      pageSize: TASK_HISTORY_PAGE_SIZE
    });
    collection.taskPage = historyPage.page;
    const result = document.createElement("div");
    result.className = "novel-collection-history-result";
    result.textContent = historyPage.total
      ? `共 ${formatNumber(historyPage.total)} 条 · 第 ${formatNumber(historyPage.page + 1)} / ${formatNumber(historyPage.pageCount)} 页`
      : "没有匹配的任务记录";
    history.append(result);

    const list = document.createElement("div");
    list.className = "novel-collection-task-list-rows";
    if (!collection.tasks.length) {
      list.append(emptyCard(collection.loading ? "正在读取任务…" : "还没有采集任务。"));
    } else if (!historyPage.tasks.length) {
      list.append(emptyCard("当前筛选条件下没有任务记录。"));
    } else {
      for (const task of historyPage.tasks) list.append(renderTaskListItem(task));
    }
    history.append(list);
    const pagination = renderTaskPagination(collection, historyPage.pageCount);
    if (pagination) history.append(pagination);
    listPanel.append(history);
    section.append(listPanel);
    return section;
  }

  function renderTaskFilters(collection, tasks) {
    const controls = document.createElement("div");
    controls.className = "novel-collection-task-controls";
    const filters = document.createElement("div");
    filters.className = "novel-collection-task-filters";
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "任务状态筛选");
    const counts = {
      all: tasks.length,
      failed: tasks.filter((task) => task.status === "failed").length,
      succeeded: tasks.filter((task) => task.status === "succeeded").length,
      cancelled: tasks.filter((task) => task.status === "cancelled").length
    };
    for (const [value, label] of [["all", "全部"], ["failed", "失败"], ["succeeded", "已完成"], ["cancelled", "已取消"]]) {
      const button = actionButton(`${label} ${formatNumber(counts[value] || 0)}`, collection.taskFilter === value ? "filter active" : "filter", () => {
        if (collection.taskFilter === value) return;
        collection.taskFilter = value;
        collection.taskPage = 0;
        rerender();
      });
      button.setAttribute("aria-pressed", collection.taskFilter === value ? "true" : "false");
      filters.append(button);
    }

    const search = document.createElement("form");
    search.className = "novel-collection-task-search";
    search.setAttribute("role", "search");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "搜索任务、网址或适配器";
    input.value = collection.taskSearchDraft;
    input.setAttribute("aria-label", "搜索任务记录");
    input.addEventListener("input", () => {
      collection.taskSearchDraft = input.value;
    });
    const submit = actionButton("搜索", "secondary", () => applyTaskSearch(collection, input.value));
    search.addEventListener("submit", (event) => {
      event.preventDefault();
      applyTaskSearch(collection, input.value);
    });
    search.append(input, submit);
    if (collection.taskQuery) {
      search.append(actionButton("清除", "ghost", () => {
        collection.taskQuery = "";
        collection.taskSearchDraft = "";
        collection.taskPage = 0;
        rerender();
      }));
    }
    controls.append(filters, search);
    return controls;
  }

  function applyTaskSearch(collection, value) {
    collection.taskQuery = String(value || "").trim();
    collection.taskSearchDraft = collection.taskQuery;
    collection.taskPage = 0;
    rerender();
  }

  function renderTaskListItem(task) {
    const collection = ensureState();
    const taskId = String(task.id || "");
    const row = document.createElement("article");
    row.className = `novel-collection-task-list-item status-${task.status}`;
    row.dataset.collectionTaskId = taskId;
    const main = document.createElement("div");
    main.className = "novel-collection-task-list-item-main";
    const copy = document.createElement("div");
    copy.className = "novel-collection-task-list-item-copy";
    const titleRow = document.createElement("div");
    titleRow.className = "novel-collection-task-list-item-title";
    const title = document.createElement("h4");
    title.textContent = task.name || "采集任务";
    const badge = document.createElement("span");
    badge.className = `novel-task-status ${task.status}`;
    badge.dataset.taskField = "status";
    badge.textContent = statusLabel(task.status);
    titleRow.append(title, badge);
    const meta = document.createElement("p");
    meta.dataset.taskField = "meta";
    meta.textContent = `${task.adapterName || "未知适配器"} · ${task.mode === "test" ? "测试" : "完整采集"} · ${taskTime(task)}`;
    const message = document.createElement("p");
    message.dataset.taskField = "message";
    message.className = task.error ? "novel-collection-task-list-item-message error" : "novel-collection-task-list-item-message";
    message.textContent = task.error || task.message || "等待执行";
    copy.append(titleRow, meta, message);

    const actions = document.createElement("div");
    actions.className = "novel-collection-task-list-item-actions";
    const verificationUrl = aliceswVerificationUrl(task);
    if (task.bookId) actions.append(actionButton("打开小说", "primary", () => openBook(task.bookId)));
    if (ACTIVE_STATUSES.has(task.status)) {
      const cancel = actionButton(task.status === "cancelling" ? "正在取消" : "取消", "danger", () => mutateTask(task.id, "cancel"));
      cancel.disabled = task.status === "cancelling";
      actions.append(cancel);
    } else if (verificationUrl) {
      const openVerification = actionButton("打开验证页", "secondary", () => {
        window.open(verificationUrl, "_blank", "noopener,noreferrer");
      });
      openVerification.title = "在爱丽丝书屋完成访问验证码";
      const configureAndRetry = actionButton("配置并继续", "primary", () => {
        openAliceswCredentialEditor({
          targetUrl: verificationUrl,
          retryTaskId: task.id
        });
      });
      configureAndRetry.title = task.checkpointCount
        ? `检测 Cookie 通过后从已保存的 ${formatNumber(task.checkpointCount)} 章继续`
        : "检测 Cookie 通过后重新执行任务";
      actions.append(
        openVerification,
        configureAndRetry,
        actionButton("删除", "ghost", () => deleteTask(task))
      );
    } else {
      const retryLabel = task.status === "succeeded"
        ? "重新采集"
        : task.checkpointCount
          ? "从断点继续"
          : "重试";
      actions.append(
        actionButton(retryLabel, "secondary", () => mutateTask(task.id, "run")),
        actionButton("删除", "ghost", () => deleteTask(task))
      );
    }
    main.append(copy, actions);
    row.append(main);

    const total = Math.max(0, Number(task.progressTotal || 0));
    const current = Math.max(0, Number(task.progressCurrent || 0));
    if (ACTIVE_STATUSES.has(task.status)) {
      const progress = document.createElement("div");
      progress.className = "novel-collection-task-list-item-progress";
      progress.dataset.taskProgress = "";
      progress.hidden = !total;
      const bar = document.createElement("span");
      bar.dataset.taskProgressBar = "";
      bar.style.width = `${total ? Math.max(0, Math.min(100, (current / total) * 100)) : 0}%`;
      progress.append(bar);
      row.append(progress);
    }

    const details = document.createElement("details");
    details.className = "novel-collection-task-list-item-details";
    details.open = Boolean(taskId && collection.expandedTaskIds.has(taskId));
    let log = null;
    const restoreTaskLogView = () => restoreTaskLogElement(collection, taskId, details, log);
    details.addEventListener("toggle", () => {
      if (!taskId) return;
      if (details.open) {
        collection.expandedTaskIds.add(taskId);
        queueMicrotask(restoreTaskLogView);
      } else {
        collection.expandedTaskIds.delete(taskId);
      }
    });
    const summary = document.createElement("summary");
    summary.textContent = "详情与日志";
    const body = document.createElement("div");
    body.className = "novel-collection-task-list-item-detail-body";
    body.dataset.taskDetailBody = "";
    const url = document.createElement("a");
    url.className = "novel-collection-task-url";
    url.href = task.startUrl;
    url.target = "_blank";
    url.rel = "noopener noreferrer";
    url.textContent = task.startUrl;
    body.append(url);
    const facts = document.createElement("div");
    facts.className = "novel-collection-task-facts";
    if (total || ACTIVE_STATUSES.has(task.status)) {
      const progressFact = fact("进度", `${formatNumber(current)} / ${formatNumber(total)}`);
      progressFact.dataset.taskField = "progress-fact";
      progressFact.hidden = !total;
      facts.append(progressFact);
    }
    if (task.result?.chapterCount) facts.append(fact("章节", formatNumber(task.result.chapterCount)));
    if (task.result?.charCount) facts.append(fact("正文", `${formatNumber(task.result.charCount)} 字`));
    if (task.checkpointCount || ACTIVE_STATUSES.has(task.status)) {
      const checkpointFact = fact("已记录", `${formatNumber(task.checkpointCount)} 章`);
      checkpointFact.dataset.taskField = "checkpoint-fact";
      checkpointFact.hidden = !task.checkpointCount;
      facts.append(checkpointFact);
    }
    if (task.attempt) facts.append(fact("执行", `${formatNumber(task.attempt)} 次`));
    if (facts.childElementCount) body.append(facts);
    if (task.mode === "test" && task.result?.preview) {
      const preview = document.createElement("p");
      preview.className = "novel-collection-task-record-preview";
      preview.textContent = task.result.preview;
      body.append(preview);
    }
    if (task.logTail) {
      log = document.createElement("pre");
      log.textContent = task.logTail;
      attachTaskLogTracking(log, collection, taskId);
      body.append(log);
    }
    details.append(summary, body);
    row.append(details);
    if (details.open && log) queueMicrotask(restoreTaskLogView);
    return row;
  }

  function restoreTaskLogElement(collection, taskId, details, log) {
    if (!log?.isConnected || !details?.open) return;
    const view = collection.taskLogViews.get(taskId);
    if (!view || view.followLatest) {
      log.scrollTop = log.scrollHeight;
      return;
    }
    const maxScrollTop = Math.max(0, log.scrollHeight - log.clientHeight);
    log.scrollTop = Math.min(maxScrollTop, Math.max(0, Number(view.scrollTop || 0)));
  }

  function attachTaskLogTracking(log, collection, taskId) {
    log.dataset.taskLog = "";
    log.addEventListener("scroll", () => {
      const maxScrollTop = Math.max(0, log.scrollHeight - log.clientHeight);
      collection.taskLogViews.set(taskId, {
        scrollTop: log.scrollTop,
        followLatest: maxScrollTop - log.scrollTop <= 24
      });
    });
  }

  function canPatchPolledTasks(previousTasks, nextTasks) {
    if (previousTasks.length !== nextTasks.length) return false;
    const previous = new Map(previousTasks.map((task) => [String(task.id || ""), task]));
    return nextTasks.every((task) => {
      const before = previous.get(String(task.id || ""));
      if (!before) return false;
      const wasActive = ACTIVE_STATUSES.has(before.status);
      const isActive = ACTIVE_STATUSES.has(task.status);
      if (wasActive !== isActive) return false;
      return isActive || before.status === task.status;
    });
  }

  function patchPolledTaskRows(collection) {
    const tasks = new Map(collection.tasks.map((task) => [String(task.id || ""), task]));
    for (const row of document.querySelectorAll(".novel-collection-task-list-item[data-collection-task-id]")) {
      const taskId = String(row.dataset.collectionTaskId || "");
      const task = tasks.get(taskId);
      if (!task) continue;
      row.className = `novel-collection-task-list-item status-${task.status}`;

      const badge = row.querySelector('[data-task-field="status"]');
      if (badge) {
        badge.className = `novel-task-status ${task.status}`;
        badge.textContent = statusLabel(task.status);
      }
      const meta = row.querySelector('[data-task-field="meta"]');
      if (meta) meta.textContent = `${task.adapterName || "未知适配器"} · ${task.mode === "test" ? "测试" : "完整采集"} · ${taskTime(task)}`;
      const message = row.querySelector('[data-task-field="message"]');
      if (message) {
        message.className = task.error ? "novel-collection-task-list-item-message error" : "novel-collection-task-list-item-message";
        message.textContent = task.error || task.message || "等待执行";
      }
      const cancel = row.querySelector(".novel-collection-task-list-item-actions .danger");
      if (cancel && ACTIVE_STATUSES.has(task.status)) {
        cancel.textContent = task.status === "cancelling" ? "正在取消" : "取消";
        cancel.disabled = task.status === "cancelling";
      }

      const total = Math.max(0, Number(task.progressTotal || 0));
      const current = Math.max(0, Number(task.progressCurrent || 0));
      const progress = row.querySelector("[data-task-progress]");
      const bar = row.querySelector("[data-task-progress-bar]");
      if (progress) progress.hidden = !total;
      if (bar) bar.style.width = `${total ? Math.max(0, Math.min(100, (current / total) * 100)) : 0}%`;
      const progressFact = row.querySelector('[data-task-field="progress-fact"]');
      if (progressFact) progressFact.hidden = !total;
      updateFactValue(progressFact, `${formatNumber(current)} / ${formatNumber(total)}`);
      const checkpointFact = row.querySelector('[data-task-field="checkpoint-fact"]');
      if (checkpointFact) checkpointFact.hidden = !task.checkpointCount;
      updateFactValue(checkpointFact, `${formatNumber(task.checkpointCount || 0)} 章`);

      patchTaskLog(row, collection, taskId, String(task.logTail || ""));
    }
  }

  function updateFactValue(item, value) {
    if (item?.lastChild?.nodeType === Node.TEXT_NODE) item.lastChild.nodeValue = value;
  }

  function patchTaskLog(row, collection, taskId, nextText) {
    const details = row.querySelector("details.novel-collection-task-list-item-details");
    const body = row.querySelector("[data-task-detail-body]");
    let log = row.querySelector("[data-task-log]");
    if (!log && nextText && body) {
      log = document.createElement("pre");
      log.textContent = nextText;
      attachTaskLogTracking(log, collection, taskId);
      body.append(log);
      if (details?.open) queueMicrotask(() => restoreTaskLogElement(collection, taskId, details, log));
      return;
    }
    if (!log || log.textContent === nextText) return;

    const view = collection.taskLogViews.get(taskId);
    const maxScrollTop = Math.max(0, log.scrollHeight - log.clientHeight);
    const followLatest = view?.followLatest ?? (maxScrollTop - log.scrollTop <= 24);
    const previousScrollTop = log.scrollTop;
    const currentText = log.textContent || "";
    if (nextText.startsWith(currentText)) {
      log.append(document.createTextNode(nextText.slice(currentText.length)));
    } else {
      log.textContent = nextText;
    }
    if (followLatest && details?.open) {
      queueMicrotask(() => {
        if (log.isConnected) log.scrollTop = log.scrollHeight;
      });
    } else {
      log.scrollTop = Math.min(previousScrollTop, Math.max(0, log.scrollHeight - log.clientHeight));
    }
  }

  function renderTaskNavItem(collection, task) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `novel-collection-task-nav-item status-${task.status}`;
    if (collection.selectedTaskId === task.id && collection.workspaceView === "tasks") {
      item.classList.add("selected");
      item.setAttribute("aria-current", "true");
    }
    const titleRow = document.createElement("span");
    titleRow.className = "novel-collection-task-nav-title";
    const title = document.createElement("strong");
    title.textContent = task.name || "采集任务";
    const badge = document.createElement("span");
    badge.className = `novel-task-status ${task.status}`;
    badge.textContent = statusLabel(task.status);
    titleRow.append(title, badge);
    const meta = document.createElement("span");
    meta.className = "novel-collection-task-nav-meta";
    meta.textContent = `${task.adapterName || "未知适配器"} · ${taskTime(task)}`;
    const message = document.createElement("span");
    message.className = task.error ? "novel-collection-task-nav-message error" : "novel-collection-task-nav-message";
    message.textContent = task.error || task.message || "等待执行";
    item.append(titleRow, meta, message);
    const total = Math.max(0, Number(task.progressTotal || 0));
    const current = Math.max(0, Number(task.progressCurrent || 0));
    if (total && ACTIVE_STATUSES.has(task.status)) {
      const progress = document.createElement("span");
      progress.className = "novel-collection-task-nav-progress";
      const progressBar = document.createElement("span");
      progressBar.style.width = `${Math.max(0, Math.min(100, (current / total) * 100))}%`;
      progress.append(progressBar);
      item.append(progress);
    }
    item.addEventListener("click", () => {
      collection.selectedTaskId = task.id;
      collection.workspaceView = "tasks";
      rerender();
    });
    return item;
  }

  function renderTaskPagination(collection, pageCount) {
    if (pageCount <= 1) return null;
    const nav = document.createElement("nav");
    nav.className = "novel-collection-pagination";
    nav.setAttribute("aria-label", "任务记录分页");
    const previous = actionButton("上一页", "ghost", () => changeTaskPage(collection, collection.taskPage - 1, pageCount));
    previous.disabled = collection.taskPage <= 0;
    nav.append(previous);
    for (const page of compactPaginationPages(pageCount, collection.taskPage)) {
      if (page === null) {
        const ellipsis = document.createElement("span");
        ellipsis.textContent = "…";
        ellipsis.setAttribute("aria-hidden", "true");
        nav.append(ellipsis);
        continue;
      }
      const button = actionButton(formatNumber(page + 1), page === collection.taskPage ? "filter active" : "filter", () => changeTaskPage(collection, page, pageCount));
      button.setAttribute("aria-label", `第 ${formatNumber(page + 1)} 页`);
      if (page === collection.taskPage) button.setAttribute("aria-current", "page");
      nav.append(button);
    }
    const next = actionButton("下一页", "ghost", () => changeTaskPage(collection, collection.taskPage + 1, pageCount));
    next.disabled = collection.taskPage >= pageCount - 1;
    nav.append(next);
    return nav;
  }

  function changeTaskPage(collection, page, pageCount) {
    const nextPage = Math.max(0, Math.min(pageCount - 1, Number(page || 0)));
    if (nextPage === collection.taskPage) return;
    collection.taskPage = nextPage;
    rerender();
    queueMicrotask(() => document.querySelector(".novel-collection-task-browser")?.scrollIntoView({ block: "nearest", behavior: "auto" }));
  }

  function renderTask(task) {
    const card = document.createElement("article");
    card.className = `novel-collection-task status-${task.status}`;
    const top = document.createElement("div");
    top.className = "novel-collection-task-top";
    const copy = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = task.name || "采集任务";
    const meta = document.createElement("p");
    meta.textContent = `${task.adapterName || "未知适配器"} · ${task.mode === "test" ? "测试" : "完整采集"} · ${taskTime(task)}`;
    copy.append(title, meta);
    const badge = document.createElement("span");
    badge.className = `novel-task-status ${task.status}`;
    badge.textContent = statusLabel(task.status);
    top.append(copy, badge);

    const url = document.createElement("a");
    url.className = "novel-collection-task-url";
    url.href = task.startUrl;
    url.target = "_blank";
    url.rel = "noopener noreferrer";
    url.textContent = task.startUrl;

    const progress = document.createElement("div");
    progress.className = "novel-collection-progress";
    const progressBar = document.createElement("span");
    const total = Math.max(0, Number(task.progressTotal || 0));
    const current = Math.max(0, Number(task.progressCurrent || 0));
    const ratio = total ? Math.min(1, current / total) : task.status === "succeeded" ? 1 : 0;
    progressBar.style.width = `${Math.round(ratio * 100)}%`;
    progress.append(progressBar);
    if (!ACTIVE_STATUSES.has(task.status) && !total) progress.hidden = true;

    const message = document.createElement("p");
    message.className = task.error ? "novel-collection-task-message error" : "novel-collection-task-message";
    message.textContent = task.error || task.message || "等待执行";

    const facts = document.createElement("div");
    facts.className = "novel-collection-task-facts";
    if (total) facts.append(fact("进度", `${formatNumber(current)} / ${formatNumber(total)}`));
    if (task.result?.chapterCount) facts.append(fact("章节", formatNumber(task.result.chapterCount)));
    if (task.result?.charCount) facts.append(fact("正文", `${formatNumber(task.result.charCount)} 字`));
    if (task.checkpointCount) facts.append(fact("已记录", `${formatNumber(task.checkpointCount)} 章`));
    else if (["failed", "cancelled"].includes(task.status) && current) facts.append(fact("断点", "旧任务未保存"));
    if (task.attempt) facts.append(fact("执行", `${formatNumber(task.attempt)} 次`));

    const actions = document.createElement("div");
    actions.className = "novel-collection-task-actions";
    if (task.bookId) {
      actions.append(actionButton("打开小说", "primary", () => openBook(task.bookId)));
    }
    if (ACTIVE_STATUSES.has(task.status)) {
      actions.append(actionButton(task.status === "cancelling" ? "正在取消" : "取消", "danger", () => mutateTask(task.id, "cancel")));
      actions.lastElementChild.disabled = task.status === "cancelling";
    } else {
      const retryLabel = task.status === "succeeded"
        ? "重新采集"
        : task.checkpointCount
          ? "从断点继续"
          : "重试";
      actions.append(actionButton(retryLabel, "secondary", () => mutateTask(task.id, "run")));
      actions.append(actionButton("删除记录", "ghost", () => deleteTask(task)));
    }

    card.append(top, url, progress, message);
    if (facts.childElementCount) card.append(facts);
    if (task.mode === "test" && task.result?.preview) {
      const details = document.createElement("details");
      details.className = "novel-collection-preview";
      const summary = document.createElement("summary");
      summary.textContent = "查看正文预览";
      const preview = document.createElement("p");
      preview.textContent = task.result.preview;
      details.append(summary, preview);
      card.append(details);
    }
    if (task.logTail) {
      const details = document.createElement("details");
      details.className = "novel-collection-log";
      const summary = document.createElement("summary");
      const lines = String(task.logTail).split(/\r?\n/).filter(Boolean);
      summary.textContent = `查看详细日志（${formatNumber(lines.length)} 行）`;
      const log = document.createElement("pre");
      log.textContent = task.logTail;
      details.append(summary, log);
      card.append(details);
    }
    card.append(actions);
    return card;
  }

  function renderAdapters(collection, options = {}) {
    const embedded = Boolean(options.embedded);
    const section = document.createElement(embedded ? "section" : "details");
    section.className = embedded
      ? "novel-adapter-workspace"
      : "novel-collection-panel novel-adapter-panel";
    if (embedded) {
      const head = document.createElement("div");
      head.className = "novel-collection-workspace-detail-head";
      const copy = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = "站点适配器";
      const description = document.createElement("p");
      description.textContent = "维护内置站点与自定义 CSS 选择器配置。";
      copy.append(title, description);
      const actions = document.createElement("div");
      actions.className = "novel-adapter-panel-actions";
      const count = document.createElement("span");
      count.className = "novel-adapter-panel-count";
      count.textContent = `${formatNumber(collection.adapters.length)} 个`;
      actions.append(count, actionButton("新建自定义适配器", "primary", () => openAdapterEditor()));
      head.append(copy, actions);
      section.append(head);
    } else {
      section.open = collection.adaptersOpen;
      section.addEventListener("toggle", () => {
        collection.adaptersOpen = section.open;
      });
      const summary = document.createElement("summary");
      summary.className = "novel-adapter-panel-summary";
      const summaryCopy = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = "站点适配器";
      const description = document.createElement("p");
      description.textContent = "内置与自定义适配器默认收起，需要维护时再展开。";
      summaryCopy.append(title, description);
      const count = document.createElement("span");
      count.className = "novel-adapter-panel-count";
      count.textContent = `${formatNumber(collection.adapters.length)} 个`;
      const toggle = document.createElement("span");
      toggle.className = "novel-adapter-panel-toggle";
      toggle.textContent = collection.adaptersOpen ? "收起" : "展开";
      summary.append(summaryCopy, count, toggle);
      section.append(summary);
      section.addEventListener("toggle", () => {
        toggle.textContent = section.open ? "收起" : "展开";
      });
    }
    const body = document.createElement("div");
    body.className = "novel-adapter-panel-body";
    if (!embedded) {
      const actions = document.createElement("div");
      actions.className = "novel-adapter-panel-actions";
      actions.append(actionButton("新建自定义适配器", "primary", () => openAdapterEditor()));
      body.append(actions);
    }
    const list = document.createElement("div");
    list.className = "novel-adapter-list";
    for (const adapter of collection.adapters) {
      const card = document.createElement("article");
      card.className = "novel-adapter-card";
      const top = document.createElement("div");
      const name = document.createElement("h4");
      name.textContent = adapter.name;
      const type = document.createElement("span");
      type.className = `novel-adapter-type ${adapter.system ? "system" : "custom"}`;
      type.textContent = adapter.system ? "内置" : "自定义";
      top.append(name, type);
      const description = document.createElement("p");
      description.textContent = adapter.description || "未填写说明";
      const hosts = document.createElement("code");
      hosts.textContent = (adapter.matchHosts || []).join(" · ");
      card.append(top, description, hosts);
      if (!adapter.system) {
        const actions = document.createElement("div");
        actions.className = "novel-adapter-actions";
        actions.append(
          actionButton("编辑", "secondary", () => openAdapterEditor(adapter)),
          actionButton("删除", "danger", () => deleteAdapter(adapter))
        );
        card.append(actions);
      }
      list.append(card);
    }
    if (!collection.adapters.length) list.append(emptyCard(collection.loading ? "正在读取适配器…" : "暂无适配器。"));
    body.append(list);
    section.append(body);
    return section;
  }

  async function submitTask(mode) {
    const collection = ensureState();
    const url = collection.draftUrl.trim();
    if (!url || collection.submitting) return;
    collection.submitting = true;
    collection.error = "";
    collection.notice = "";
    rerender();
    try {
      const result = await api("/api/novels/collection/tasks", {
        method: "POST",
        body: {
          url,
          name: collection.draftName.trim(),
          adapterId: collection.draftAdapterId || "auto",
          mode
        }
      });
      collection.notice = mutationNotice(result);
      collection.draftName = "";
      collection.selectedTaskId = String(result?.task?.id || result?.id || collection.selectedTaskId || "");
      collection.workspaceView = "tasks";
      await load({ silent: true });
    } catch (error) {
      collection.error = error.message || "采集任务创建失败";
    } finally {
      collection.submitting = false;
      rerender();
    }
  }

  async function mutateTask(taskId, action) {
    const collection = ensureState();
    collection.error = "";
    collection.notice = "";
    try {
      const result = await api(`/api/novels/collection/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST" });
      collection.notice = mutationNotice(result);
      await load({ silent: true });
    } catch (error) {
      collection.error = error.message || "任务操作失败";
    }
    rerender();
  }

  async function deleteTask(task) {
    if (!window.confirm(`删除任务记录“${task.name || "采集任务"}”？已导入的小说不会删除。`)) return;
    const collection = ensureState();
    collection.notice = "";
    try {
      await api(`/api/novels/collection/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      await load({ silent: true });
    } catch (error) {
      collection.error = error.message || "任务记录删除失败";
    }
    rerender();
  }

  function openAdapterEditor(adapter = null) {
    const collection = ensureState();
    const config = adapter?.config || {};
    const dialog = document.createElement("dialog");
    dialog.className = "novel-adapter-dialog";
    const form = document.createElement("form");
    form.method = "dialog";
    const head = document.createElement("div");
    head.className = "novel-adapter-dialog-head";
    const title = document.createElement("h2");
    title.textContent = adapter ? "编辑自定义适配器" : "新建自定义适配器";
    const close = actionButton("×", "ghost", () => dialog.close());
    close.setAttribute("aria-label", "关闭");
    head.append(title, close);
    const help = document.createElement("p");
    help.className = "novel-adapter-help";
    help.textContent = "选择器按目录页和章节页分别填写。若“章节链接”留空，起始网页会被当作单章正文采集。";

    const basic = document.createElement("div");
    basic.className = "novel-adapter-form-grid";
    const name = field("适配器名称", "text", adapter?.name || "", "例如：示例小说站");
    name.input.required = true;
    const hosts = field("匹配域名", "text", (adapter?.matchHosts || []).join(", "), "example.com, *.example.com");
    hosts.input.required = true;
    const description = textAreaField("说明", adapter?.description || "", "记录适用页面和注意事项");
    const bookTitle = field("书名选择器", "text", config.bookTitleSelector || "", "h1.book-title");
    const author = field("作者选择器", "text", config.authorSelector || "", ".book-author");
    const catalog = field("目录容器选择器", "text", config.catalogSelector || "", ".chapter-list");
    const chapterLink = field("章节链接选择器", "text", config.chapterLinkSelector || "", "a.chapter");
    const chapterTitle = field("章节页标题选择器", "text", config.chapterTitleSelector || "", "h1.chapter-title");
    const content = field("正文选择器", "text", config.contentSelector || "", "article.content");
    content.input.required = true;
    const catalogNext = field("目录下一页选择器", "text", config.catalogNextSelector || "", "a.next");
    const chapterNext = field("章节下一页选择器", "text", config.chapterNextSelector || "", "a.next-page");
    const urlPattern = field("章节网址正则", "text", config.chapterUrlPattern || "", "/chapter/\\d+");
    const remove = textAreaField("移除元素选择器（每行一个）", (config.removeSelectors || []).join("\n"), ".advert\n.chapter-nav");
    const removeLines = textAreaField("过滤正文正则（每行一个）", (config.removeLinePatterns || []).join("\n"), "^本章未完");
    const delay = field("请求间隔（毫秒）", "number", String(config.delayMs ?? 800), "800");
    delay.input.min = "0";
    delay.input.max = "60000";
    const timeout = field("请求超时（毫秒）", "number", String(config.timeoutMs ?? 30000), "30000");
    timeout.input.min = "3000";
    timeout.input.max = "120000";
    basic.append(
      name.label,
      hosts.label,
      description.label,
      bookTitle.label,
      author.label,
      catalog.label,
      chapterLink.label,
      chapterTitle.label,
      content.label,
      catalogNext.label,
      chapterNext.label,
      urlPattern.label,
      remove.label,
      removeLines.label,
      delay.label,
      timeout.label
    );
    const actions = document.createElement("div");
    actions.className = "novel-adapter-dialog-actions";
    const cancel = actionButton("取消", "ghost", () => dialog.close());
    const save = actionButton(adapter ? "保存适配器" : "创建适配器", "primary", async () => {
      if (!form.reportValidity()) return;
      save.disabled = true;
      try {
        const payload = {
          name: name.input.value.trim(),
          matchHosts: splitLines(hosts.input.value),
          description: description.input.value.trim(),
          config: {
            bookTitleSelector: bookTitle.input.value.trim(),
            authorSelector: author.input.value.trim(),
            catalogSelector: catalog.input.value.trim(),
            chapterLinkSelector: chapterLink.input.value.trim(),
            chapterTitleSelector: chapterTitle.input.value.trim(),
            contentSelector: content.input.value.trim(),
            catalogNextSelector: catalogNext.input.value.trim(),
            chapterNextSelector: chapterNext.input.value.trim(),
            chapterUrlPattern: urlPattern.input.value.trim(),
            removeSelectors: splitLines(remove.input.value),
            removeLinePatterns: splitLines(removeLines.input.value),
            delayMs: Number(delay.input.value || 800),
            timeoutMs: Number(timeout.input.value || 30000)
          }
        };
        const endpoint = adapter
          ? `/api/novels/collection/adapters/${encodeURIComponent(adapter.id)}`
          : "/api/novels/collection/adapters";
        await api(endpoint, { method: adapter ? "PATCH" : "POST", body: payload });
        dialog.close();
        await load();
      } catch (error) {
        collection.error = error.message || "适配器保存失败";
        save.disabled = false;
        rerender();
      }
    });
    actions.append(cancel, save);
    form.append(head, help, basic, actions);
    form.addEventListener("submit", (event) => event.preventDefault());
    dialog.append(form);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    name.input.focus();
  }

  function openAliceswCredentialEditor(options = {}) {
    const collection = ensureState();
    const current = collection.credentials?.alicesw || {};
    const targetUrl = normalizeAliceswUrl(options.targetUrl) || preferredAliceswUrl(collection);
    const retryTaskId = String(options.retryTaskId || "");
    const dialog = document.createElement("dialog");
    dialog.className = "novel-adapter-dialog novel-credential-dialog";
    const form = document.createElement("form");
    form.method = "dialog";
    const head = document.createElement("div");
    head.className = "novel-adapter-dialog-head";
    const title = document.createElement("h2");
    title.textContent = "爱丽丝书屋登录配置";
    const close = actionButton("×", "ghost", () => dialog.close());
    close.setAttribute("aria-label", "关闭");
    head.append(title, close);

    const help = document.createElement("p");
    help.className = "novel-adapter-help";
    help.textContent = retryTaskId
      ? `先打开验证页并在浏览器完成验证码，再粘贴请求头中的完整 Cookie。${current.configured ? "本机已有配置，留空可直接重新检测。" : ""}检测通过后会自动从原任务断点继续。`
      : current.configured
        ? `本机已有 Cookie${current.hasLoginCredentials ? "，包含登录凭据" : ""}。输入新内容会覆盖；留空可直接检测现有配置。`
        : "在浏览器登录 alicesw.com 并通过访问验证后，复制请求头中的完整 Cookie。内容只保存在本机，不会回显到页面、接口、任务记录或日志。";

    const cookie = textAreaField(
      "完整 Cookie",
      "",
      current.configured ? "已配置；留空不会覆盖" : "server_name_session=...; PHPSESSID=...; lf_user_auth=..."
    );
    cookie.input.rows = 8;
    cookie.input.autocomplete = "off";
    cookie.input.spellcheck = false;

    const target = field(
      "检测网址（可选）",
      "url",
      targetUrl,
      "https://www.alicesw.com/other/chapters/id/31510.html"
    );
    const status = document.createElement("p");
    status.className = "novel-credential-status";
    status.textContent = current.configured
      ? `已配置${current.updatedAt ? ` · 更新于 ${formatDateTimeSafe(current.updatedAt)}` : ""}`
      : "尚未配置";

    const actions = document.createElement("div");
    actions.className = "novel-adapter-dialog-actions";
    if (targetUrl) {
      const openVerification = actionButton("打开验证页", "secondary", () => {
        window.open(targetUrl, "_blank", "noopener,noreferrer");
      });
      openVerification.title = "在爱丽丝书屋完成访问验证码";
      actions.append(openVerification);
    }
    if (current.configured) {
      const clear = actionButton("清除配置", "danger", async () => {
        if (!window.confirm("清除本机保存的爱丽丝书屋 Cookie？")) return;
        setCredentialDialogBusy(actions, true);
        setCredentialStatus(status, "正在清除…");
        try {
          await api("/api/admin/settings/novels/actions/clear-alicesw-cookie", {
            method: "POST",
            body: { payload: {} }
          });
          collection.notice = "已清除爱丽丝书屋 Cookie";
          await load({ silent: true });
          dialog.close();
          rerender();
        } catch (error) {
          setCredentialStatus(status, error.message || "清除 Cookie 失败", true);
          setCredentialDialogBusy(actions, false);
        }
      });
      actions.append(clear);
    }
    const cancel = actionButton("取消", "ghost", () => dialog.close());
    const save = actionButton(
      retryTaskId
        ? (current.configured ? "检测并继续采集" : "保存并继续采集")
        : (current.configured ? "保存或检测" : "保存并检测"),
      "primary",
      async () => {
      const cookieValue = cookie.input.value.trim();
      if (!current.configured && !cookieValue) {
        setCredentialStatus(status, "请先粘贴完整 Cookie", true);
        cookie.input.focus();
        return;
      }
      setCredentialDialogBusy(actions, true);
      setCredentialStatus(status, cookieValue ? "正在保存并检测…" : "正在检测现有配置…");
      try {
        if (cookieValue) {
          await api("/api/admin/settings/novels", {
            method: "PATCH",
            body: { values: { aliceswCookie: cookieValue } }
          });
          cookie.input.value = "";
        }
        const data = await api("/api/admin/settings/novels/actions/test-alicesw-cookie", {
          method: "POST",
          body: { payload: { url: target.input.value.trim() } }
        });
        const result = data.action?.result || {};
        if (result.ok === false) {
          throw new Error(result.error || result.message || "Cookie 检测失败");
        }
        collection.notice = result.message || "爱丽丝书屋登录配置检测通过";
        await load({ silent: true });
        dialog.close();
        if (retryTaskId) {
          await mutateTask(retryTaskId, "run");
          return;
        }
        rerender();
      } catch (error) {
        setCredentialStatus(status, error.message || "Cookie 保存或检测失败", true);
        setCredentialDialogBusy(actions, false);
      }
      }
    );
    actions.append(cancel, save);
    form.append(head, help, cookie.label, target.label, status, actions);
    form.addEventListener("submit", (event) => event.preventDefault());
    dialog.append(form);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    cookie.input.focus();
  }

  async function deleteAdapter(adapter) {
    if (!window.confirm(`删除自定义适配器“${adapter.name}”？历史任务仍会保留当时的适配配置。`)) return;
    const collection = ensureState();
    try {
      await api(`/api/novels/collection/adapters/${encodeURIComponent(adapter.id)}`, { method: "DELETE" });
      await load({ silent: true });
    } catch (error) {
      collection.error = error.message || "适配器删除失败";
    }
    rerender();
  }

  function schedulePoll() {
    stopPolling();
    const collection = ensureState();
    if (state.novel?.mode !== "manage" || !collection.tasks.some((task) => ACTIVE_STATUSES.has(task.status))) return;
    pollTimer = window.setTimeout(async () => {
      pollTimer = null;
      if (state.novel?.mode !== "manage") return;
      const previousTasks = collection.tasks;
      await load({ silent: true });
      if (canPatchPolledTasks(previousTasks, collection.tasks)) {
        patchPolledTaskRows(collection);
      } else {
        rerender();
      }
    }, 1600);
  }

  function stopPolling() {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
  }

  return {
    ensureState,
    load,
    render,
    stopPolling
  };
}

function panelHeading(titleText, descriptionText) {
  const head = document.createElement("div");
  head.className = "novel-collection-panel-head";
  const copy = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = titleText;
  const description = document.createElement("p");
  description.textContent = descriptionText;
  copy.append(title, description);
  head.append(copy);
  return head;
}

function field(labelText, type, value, placeholder) {
  const label = document.createElement("label");
  label.className = "novel-collection-field";
  const text = document.createElement("span");
  text.textContent = labelText;
  const input = document.createElement("input");
  input.type = type;
  input.value = value || "";
  input.placeholder = placeholder || "";
  label.append(text, input);
  return { label, input };
}

function textAreaField(labelText, value, placeholder) {
  const label = document.createElement("label");
  label.className = "novel-collection-field wide";
  const text = document.createElement("span");
  text.textContent = labelText;
  const input = document.createElement("textarea");
  input.value = value || "";
  input.placeholder = placeholder || "";
  input.rows = 3;
  label.append(text, input);
  return { label, input };
}

function actionButton(label, variant, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `novel-collection-button ${variant}`;
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function emptyCard(message) {
  const empty = document.createElement("div");
  empty.className = "novel-collection-empty";
  empty.textContent = message;
  return empty;
}

function compactPaginationPages(pageCount, currentPage) {
  const pages = new Set([0, pageCount - 1]);
  for (let page = currentPage - 2; page <= currentPage + 2; page += 1) pages.add(page);
  const sorted = [...pages].filter((page) => page >= 0 && page < pageCount).sort((a, b) => a - b);
  const result = [];
  let previous = -1;
  for (const page of sorted) {
    if (previous >= 0 && page - previous > 1) result.push(null);
    result.push(page);
    previous = page;
  }
  return result;
}

function fact(label, value) {
  const item = document.createElement("span");
  const key = document.createElement("b");
  key.textContent = `${label} `;
  item.append(key, document.createTextNode(value));
  return item;
}

function statusLabel(status) {
  return {
    queued: "排队中",
    running: "采集中",
    cancelling: "取消中",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消"
  }[status] || status || "未知";
}

function taskTime(task) {
  const value = task.finishedAt || task.startedAt || task.createdAt;
  return value ? formatDateTimeSafe(value) : "刚刚";
}

function mutationNotice(result = {}) {
  if (result.alreadyActive) return "该网址已有任务正在执行，已定位到原任务记录。";
  if (result.resumed) {
    const count = Math.max(0, Number(result.task?.checkpointCount || 0));
    return count
      ? `已复用原任务记录，将从已保存的 ${count} 章继续。`
      : "已复用原任务记录，将从断点继续。";
  }
  if (result.reused) return "已复用原任务记录并重新执行。";
  return "";
}

function formatDateTimeSafe(value) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch {
    return String(value || "");
  }
}

function splitLines(value) {
  return [...new Set(String(value || "").split(/\r?\n|[,，;；]/).map((item) => item.trim()).filter(Boolean))];
}

function preferredAliceswUrl(collection) {
  const draft = String(collection.draftUrl || "").trim();
  if (/^https:\/\/(?:[^/]+\.)?alicesw\.com\//i.test(draft)) return draft;
  const task = collection.tasks.find((item) =>
    item.adapterId === "alicesw"
    || /^https:\/\/(?:[^/]+\.)?alicesw\.com\//i.test(String(item.startUrl || ""))
  );
  return String(task?.startUrl || "");
}

function normalizeAliceswUrl(value) {
  const url = String(value || "").trim();
  return /^https:\/\/(?:[^/]+\.)?alicesw\.com\//i.test(url) ? url : "";
}

function aliceswVerificationUrl(task = {}) {
  const startUrl = normalizeAliceswUrl(task.startUrl);
  const diagnostic = [task.error, task.message].map((value) => String(value || "")).join(" ");
  const isAliceswTask = task.adapterId === "alicesw" || Boolean(startUrl);
  if (!isAliceswTask || !/(?:验证码|访问验证|安全验证|captcha)/i.test(diagnostic)) return "";
  const diagnosticUrl = diagnostic.match(/https:\/\/(?:[^/\s；;，,。]+?\.)?alicesw\.com\/[^\s；;，,。]+/i)?.[0] || "";
  return normalizeAliceswUrl(diagnosticUrl) || startUrl;
}

function setCredentialStatus(node, message, error = false) {
  node.textContent = message || "";
  node.classList.toggle("error", error);
  node.classList.toggle("success", !error && Boolean(message));
}

function setCredentialDialogBusy(actions, busy) {
  for (const button of actions.querySelectorAll("button")) button.disabled = Boolean(busy);
}
