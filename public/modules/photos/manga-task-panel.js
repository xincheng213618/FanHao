const TASK_FILTERS = [
  ["all", "全部"], ["running", "运行中"], ["failed", "失败"], ["complete", "已完成"]
];
const POLL_INTERVAL_MS = 2000;

export function mangaJobNeedsLibraryRefresh(job) {
  return job?.status === "complete" || (job?.status === "failed" && job.comicAvailable && job.failedChapters > 0);
}

export function createMangaTaskPanel({ api, formatDateTime, formatNumber, openComic, findTrigger, onLibraryChanged }) {
  let active = null;
  const retrying = new Set();

  function close({ restoreFocus = true } = {}) {
    const view = active;
    if (!view) return;
    active = null;
    view.request?.abort();
    window.clearTimeout(view.timer);
    view.dialog.close();
    view.dialog.remove();
    if (restoreFocus) (view.trigger.isConnected ? view.trigger : findTrigger())?.focus({ preventScroll: true });
  }

  function open(trigger) {
    if (active || !trigger.isConnected) return;
    const dialog = element("dialog", "manga-task-dialog");
    dialog.setAttribute("aria-labelledby", "manga-task-heading");
    const header = element("header", "manga-task-header");
    const heading = element("h2", "", "漫画任务");
    heading.id = "manga-task-heading";
    const dismiss = button("关闭", () => close());
    dismiss.autofocus = true;
    header.append(heading, dismiss);
    const toolbar = element("div", "manga-task-toolbar");
    const filters = element("div", "manga-task-filters");
    filters.setAttribute("role", "group");
    filters.setAttribute("aria-label", "任务状态");
    const refresh = button("刷新", () => void load(view));
    toolbar.append(filters, refresh);
    const status = element("p", "manga-task-status");
    status.setAttribute("role", "status");
    const empty = element("p", "manga-task-empty", "当前筛选下没有任务");
    const list = element("ul", "manga-task-list");
    const view = { dialog, trigger, refresh, status, empty, list, jobs: [], rows: new Map(), errors: new Map(), filter: "all", filters: new Map(), request: null, timer: 0 };
    for (const [filter, label] of TASK_FILTERS) {
      const control = button(label, () => { view.filter = filter; render(view); });
      view.filters.set(filter, control);
      filters.append(control);
    }
    dialog.append(header, toolbar, status, empty, list);
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    active = view;
    document.body.append(dialog);
    dialog.showModal();
    render(view);
    void load(view);
  }

  async function load(view) {
    if (active !== view || view.request) return;
    window.clearTimeout(view.timer);
    const request = new AbortController();
    view.request = request;
    view.refresh.setAttribute("aria-disabled", "true");
    if (!view.jobs.length) view.status.textContent = "正在读取漫画任务…";
    try {
      const result = await api("/api/manga/jobs?limit=50", { signal: request.signal });
      if (active !== view || view.request !== request) return;
      if (!Array.isArray(result?.jobs)) throw new Error("任务列表响应不完整，请重试");
      const running = new Set(view.jobs.filter(job => job.status === "running").map(job => job.id));
      view.jobs = result.jobs.filter(isTask);
      view.status.textContent = view.jobs.length ? "" : "暂无漫画任务";
      render(view);
      const changed = view.jobs.filter(job => running.has(job.id) && mangaJobNeedsLibraryRefresh(job));
      if (changed.length) onLibraryChanged(changed);
      if (view.jobs.some(job => job.status === "running")) view.timer = window.setTimeout(() => void load(view), POLL_INTERVAL_MS);
    } catch (error) {
      if (active === view && view.request === request) view.status.textContent = error.message || "漫画任务读取失败，请重试";
    } finally {
      if (view.request === request) {
        view.request = null;
        view.refresh.removeAttribute("aria-disabled");
      }
    }
  }

  function render(view) {
    const focused = document.activeElement;
    const focusedRow = view.list.contains(focused) ? focused.closest(".manga-task-row") : null;
    const jobs = new Map(view.jobs.map(job => [job.id, job]));
    const newest = new Map();
    const running = new Set();
    for (const job of jobs.values()) {
      if (!job.comicId) continue;
      if (job.status === "running") running.add(job.comicId);
      if (!newest.has(job.comicId) || String(job.startedAt || "") > String(newest.get(job.comicId).startedAt || "")) newest.set(job.comicId, job);
    }
    for (const [filter, label] of TASK_FILTERS) {
      const control = view.filters.get(filter);
      const count = filter === "all" ? jobs.size : view.jobs.filter(job => job.status === filter).length;
      setText(control, `${label} ${formatNumber(count)}`);
      control.setAttribute("aria-pressed", String(filter === view.filter));
    }
    view.empty.hidden = !jobs.size || view.filter === "all" || view.jobs.some(job => job.status === view.filter);
    for (const [id, row] of view.rows) if (!jobs.has(id)) { row.node.remove(); view.rows.delete(id); view.errors.delete(id); }
    const wanted = [];
    for (const job of jobs.values()) {
      let row = view.rows.get(job.id);
      if (!row) { row = createRow(view, job.id); view.rows.set(job.id, row); }
      row.node.hidden = view.filter !== "all" && job.status !== view.filter;
      const label = TASK_FILTERS.find(([key]) => key === job.status)[1];
      setText(row.title, job.title || "漫画任务");
      const percent = Math.max(0, Math.min(100, Number(job.progressPercent) || 0));
      setText(row.state, job.status === "running" && percent ? `${label} ${Math.round(percent)}%` : label);
      row.state.dataset.status = job.status;
      setText(row.meta, [job.kind === "add" ? "采集" : "更新", job.site, formatDateTime(job.startedAt)].filter(Boolean).join(" · "));
      row.progress.hidden = job.status !== "running";
      row.progress.value = percent;
      row.progress.setAttribute("aria-label", `${job.title || "漫画任务"}的进度`);
      setText(row.message, [job.currentChapterTitle, job.message].filter(Boolean).join(" · "));
      setText(row.error, view.errors.get(job.id) || "");
      row.open.hidden = !job.comicAvailable || !job.comicId;
      row.retry.hidden = job.status !== "failed" || (job.comicId && newest.get(job.comicId)?.id !== job.id);
      row.retry.setAttribute("aria-disabled", String(retrying.has(job.id) || running.has(job.comicId)));
      setText(row.retry, retrying.has(job.id) ? "正在重试…" : "重试");
      wanted.push(row.node);
    }
    const anchor = focusedRow?.isConnected && !focusedRow.hidden && !focused.hidden ? focusedRow : null;
    orderRows(view.list, wanted, anchor);
    if (focusedRow && !anchor) view.refresh.focus({ preventScroll: true });
  }

  function createRow(view, id) {
    const node = element("li", "manga-task-row");
    node.dataset.jobId = id;
    const head = element("div", "manga-task-row-head");
    const title = element("strong"), state = element("span", "manga-task-state");
    head.append(title, state);
    const meta = element("p", "manga-task-meta"), message = element("p", "manga-task-message");
    const progress = element("progress", "manga-task-progress");
    progress.max = 100;
    const error = element("p", "manga-task-error");
    error.setAttribute("role", "status");
    const actions = element("div", "manga-task-actions");
    const open = button("查看作品", () => {
      const current = view.jobs.find(job => job.id === id);
      if (active !== view || !current?.comicAvailable || !current.comicId) return;
      close({ restoreFocus: false });
      openComic(current.comicId);
    });
    const retry = button("重试", () => {
      if (retry.hidden || retry.getAttribute("aria-disabled") === "true") return;
      void retryJob(view, id);
    });
    actions.append(open, retry);
    node.append(head, meta, progress, message, error, actions);
    return { node, title, state, meta, progress, message, error, open, retry };
  }

  async function retryJob(view, id) {
    if (active !== view || retrying.has(id)) return;
    retrying.add(id);
    view.errors.delete(id);
    render(view);
    try {
      const result = await api(`/api/manga/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
      if (!isTask(result?.job)) throw new Error("未收到重试结果，请刷新查看任务");
      if (active !== view) {
        if (active) restartLoad(active);
        return;
      }
      // A list already in flight may have been read before the retry receipt.
      view.jobs = [result.job, ...view.jobs.filter(job => job.id !== result.job.id)];
      view.status.textContent = "已提交重试";
      if (mangaJobNeedsLibraryRefresh(result.job)) onLibraryChanged([result.job]);
      restartLoad(view);
    } catch (error) {
      if (active === view) view.errors.set(id, error.message || "漫画任务重试失败");
    } finally {
      retrying.delete(id);
      if (active) render(active);
    }
  }

  function restartLoad(view) {
    view.request?.abort();
    view.request = null;
    void load(view);
  }

  return { open, close };
}

function isTask(job) {
  return Boolean(job?.id && ["running", "failed", "complete"].includes(job.status));
}

function orderRows(list, rows, anchor) {
  const index = rows.indexOf(anchor);
  let cursor = list.firstChild;
  for (const row of index < 0 ? rows : rows.slice(0, index)) {
    if (row !== cursor) list.insertBefore(row, cursor);
    cursor = row.nextSibling;
  }
  if (index >= 0) {
    cursor = anchor.nextSibling;
    for (const row of rows.slice(index + 1)) {
      if (row !== cursor) list.insertBefore(row, cursor);
      cursor = row.nextSibling;
    }
  }
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label, action) {
  const node = element("button", "", label);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}
