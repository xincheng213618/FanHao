const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);

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
        adapters: [],
        tasks: [],
        summary: {},
        runtime: {},
        draftUrl: "",
        draftName: "",
        draftAdapterId: "auto",
        submitting: false
      };
    }
    return state.novel.collection;
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
      collection.runtime = data.runtime || {};
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

  function render() {
    const collection = ensureState();
    const root = document.createElement("div");
    root.className = "novel-collection-admin";
    root.append(renderCollectorHeading(collection));
    if (!collection.loaded && !collection.loading) {
      queueMicrotask(() => load().catch(() => {}));
    }
    if (collection.error) {
      const error = document.createElement("div");
      error.className = "novel-collection-alert error";
      error.textContent = collection.error;
      root.append(error);
    }
    root.append(renderQuickTask(collection));
    root.append(renderTasks(collection));
    root.append(renderAdapters(collection));
    schedulePoll();
    return root;
  }

  function renderCollectorHeading(collection) {
    const head = document.createElement("div");
    head.className = "novel-collection-heading";
    const copy = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "网页采集";
    const title = document.createElement("h2");
    title.textContent = "采集任务与站点适配";
    const description = document.createElement("p");
    description.textContent = "给定网页后自动匹配内置站点；其他网页可用 CSS 选择器建立自定义适配器。测试任务只读取第一章，不会写入书库。";
    copy.append(eyebrow, title, description);
    const runtime = document.createElement("div");
    runtime.className = `novel-collector-runtime ${collection.runtime?.ready ? "ready" : "unavailable"}`;
    runtime.textContent = collection.runtime?.ready
      ? "采集器可用"
      : `采集器不可用${collection.runtime?.error ? `：${collection.runtime.error}` : ""}`;
    head.append(copy, runtime);
    return head;
  }

  function renderQuickTask(collection) {
    const section = document.createElement("section");
    section.className = "novel-collection-panel";
    const head = panelHeading("新建采集任务", "先用“测试适配”检查书名、章节与正文，再执行完整采集。");
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
    section.className = "novel-collection-panel";
    const head = panelHeading(
      "采集任务",
      collection.summary?.active
        ? `${formatNumber(collection.summary.active)} 个任务正在执行或排队`
        : "任务串行执行，避免同时请求过多页面。"
    );
    const refresh = actionButton(collection.loading ? "刷新中" : "刷新", "ghost", () => load());
    refresh.disabled = collection.loading;
    head.append(refresh);
    const list = document.createElement("div");
    list.className = "novel-collection-task-list";
    if (!collection.tasks.length) {
      list.append(emptyCard(collection.loading ? "正在读取任务…" : "还没有采集任务。"));
    } else {
      for (const task of collection.tasks.slice(0, 40)) list.append(renderTask(task));
    }
    section.append(head, list);
    return section;
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
      actions.append(actionButton(task.status === "succeeded" ? "重新采集" : "重试", "secondary", () => mutateTask(task.id, "run")));
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
    card.append(actions);
    return card;
  }

  function renderAdapters(collection) {
    const section = document.createElement("section");
    section.className = "novel-collection-panel";
    const head = panelHeading("站点适配器", "内置适配器负责已整理脚本；自定义适配器使用网页 CSS 选择器。");
    head.append(actionButton("新建自定义适配器", "primary", () => openAdapterEditor()));
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
    section.append(head, list);
    return section;
  }

  async function submitTask(mode) {
    const collection = ensureState();
    const url = collection.draftUrl.trim();
    if (!url || collection.submitting) return;
    collection.submitting = true;
    collection.error = "";
    rerender();
    try {
      await api("/api/novels/collection/tasks", {
        method: "POST",
        body: {
          url,
          name: collection.draftName.trim(),
          adapterId: collection.draftAdapterId || "auto",
          mode
        }
      });
      collection.draftName = "";
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
    try {
      await api(`/api/novels/collection/tasks/${encodeURIComponent(taskId)}/${action}`, { method: "POST" });
      await load({ silent: true });
    } catch (error) {
      collection.error = error.message || "任务操作失败";
    }
    rerender();
  }

  async function deleteTask(task) {
    if (!window.confirm(`删除任务记录“${task.name || "采集任务"}”？已导入的小说不会删除。`)) return;
    const collection = ensureState();
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
      await load({ silent: true });
      rerender();
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
