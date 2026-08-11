const ACTIVE_STATUSES = new Set(["queued", "running", "cleanup_pending", "rollback_pending"]);

export function moveJobCanRetry(job) {
  const cleanupRetryRequired = job?.status === "cleanup_pending" && (job.retryRequired === true || Boolean(String(job.errorCode || "").trim()));
  return Boolean(job?.recoverable && job.status !== "blocked" && (cleanupRetryRequired || ["failed", "rolled_back"].includes(job.status)));
}

export function moveJobStatusLabel(status) {
  return {
    queued: "排队中",
    running: "运行中",
    cleanup_pending: "待清理",
    rollback_pending: "待回滚",
    blocked: "需人工处理",
    completed: "已完成",
    rolled_back: "已回滚",
    failed: "失败"
  }[status] || status || "-";
}

export function workMoveOpsPanelIsVisible(root, pageDocument = document) {
  if (!root || pageDocument?.visibilityState === "hidden") return false;
  const view = root.closest?.("[data-admin-view]");
  return !view || view.classList?.contains("active");
}

export function fallbackCopyText(value, pageDocument = document) {
  const previousFocus = pageDocument.activeElement;
  const input = pageDocument.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  Object.assign(input.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    opacity: "0",
    pointerEvents: "none"
  });
  pageDocument.body.append(input);
  try {
    input.focus();
    input.select();
    return pageDocument.execCommand("copy") === true;
  } finally {
    input.remove();
    if (previousFocus && previousFocus !== input && typeof previousFocus.focus === "function") previousFocus.focus();
  }
}

export function createWorkMoveOpsController({ api, formatBytes, formatDateTime, root }) {
  const state = { jobs: [], summary: {}, selectedId: "", loading: false, generation: 0 };
  let activeLoad = null;
  let queuedLoad = null;
  const elements = {
    status: root?.querySelector("[data-work-move-status]"),
    workId: root?.querySelector("[data-work-move-work-id]"),
    refresh: root?.querySelector("[data-work-move-refresh]"),
    summary: root?.querySelector("[data-work-move-summary]"),
    list: root?.querySelector("[data-work-move-list]"),
    detail: root?.querySelector("[data-work-move-detail]"),
    notice: root?.querySelector("[data-work-move-notice]")
  };

  function textNode(tag, text, className = "") {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function setNotice(text) {
    if (elements.notice) elements.notice.textContent = text || "";
  }

  function queryPath() {
    const params = new URLSearchParams({ limit: "60" });
    const status = String(elements.status?.value || "").trim();
    const workId = String(elements.workId?.value || "").trim();
    if (status) params.set("status", status);
    if (workId) params.set("workId", workId);
    return `/api/work-move-jobs?${params}`;
  }

  function renderSummary() {
    if (!elements.summary) return;
    elements.summary.innerHTML = "";
    const summary = state.summary || {};
    const items = [
      ["活动", summary.active || 0],
      ["阻断", summary.blocked || 0],
      ["失败", summary.failed || 0],
      ["路径保留", summary.activeReservations || 0],
      ["最老未结", summary.oldestOutstandingAgeMs ? formatAge(summary.oldestOutstandingAgeMs) : "-"]
    ];
    for (const [label, value] of items) {
      const item = document.createElement("span");
      item.append(textNode("small", label), textNode("strong", String(value)));
      elements.summary.append(item);
    }
  }

  function renderList() {
    if (!elements.list) return;
    elements.list.innerHTML = "";
    if (!state.jobs.length) {
      elements.list.append(textNode("div", "没有匹配的作品迁移任务", "admin-empty"));
      return;
    }
    for (const job of state.jobs) {
      const card = document.createElement("button");
      card.type = "button";
      card.dataset.workMoveJobId = String(job.id || "");
      card.dataset.workMoveAction = "card";
      card.className = `work-move-job-card status-${job.status}`;
      card.classList.toggle("active", job.id === state.selectedId);
      card.setAttribute("aria-pressed", String(job.id === state.selectedId));
      card.addEventListener("click", () => {
        state.selectedId = job.id;
        render();
      });
      const head = document.createElement("span");
      head.className = "work-move-job-card-head";
      head.append(
        textNode("strong", `作品 ${job.workId || "-"}`),
        textNode("b", moveJobStatusLabel(job.status), `work-move-status status-${job.status}`)
      );
      const percent = Math.round(Math.max(0, Math.min(1, Number(job.progress || 0))) * 100);
      card.append(
        head,
        textNode("span", `${job.phase || "-"} · ${percent}% · 更新 ${formatDateTime(job.updatedAt)}`, "work-move-job-card-meta"),
        textNode("span", job.errorCode || job.error || "", "work-move-job-card-error")
      );
      elements.list.append(card);
    }
  }

  function renderDetail() {
    if (!elements.detail) return;
    const job = state.jobs.find((item) => item.id === state.selectedId) || state.jobs[0] || null;
    elements.detail.innerHTML = "";
    if (!job) {
      elements.detail.append(textNode("div", "选择任务查看详情", "admin-empty"));
      return;
    }
    state.selectedId = job.id;
    const head = document.createElement("div");
    head.className = "work-move-detail-head";
    head.append(textNode("h3", `作品 ${job.workId || "-"}`), textNode("b", moveJobStatusLabel(job.status), `work-move-status status-${job.status}`));
    const meta = document.createElement("dl");
    for (const [label, value] of [
      ["任务 ID", job.id],
      ["状态", moveJobStatusLabel(job.status)],
      ["阶段", job.phase || "-"],
      ["尝试次数", job.attempts ?? 0],
      ["文件进度", `${job.progressFiles || 0} / ${job.totalFiles || 0}`],
      ["字节进度", `${formatBytes(job.progressBytes)} / ${formatBytes(job.totalBytes)}`],
      ["创建", formatDateTime(job.createdAt)],
      ["更新", formatDateTime(job.updatedAt)],
      ["错误代码", job.errorCode || "-"]
    ]) {
      meta.append(textNode("dt", label), textNode("dd", String(value)));
    }
    const error = textNode("p", job.error || "暂无错误", "work-move-detail-error");
    const actions = document.createElement("div");
    actions.className = "admin-actions";
    if (moveJobCanRetry(job)) {
      const retry = textNode("button", "重试", "folder-button compact");
      retry.type = "button";
      retry.dataset.workMoveJobId = String(job.id || "");
      retry.dataset.workMoveAction = "retry";
      retry.addEventListener("click", () => retryJob(job, retry));
      actions.append(retry);
    }
    if (job.status === "blocked") {
      elements.detail.append(textNode("p", "任务为防止双重文件操作而阻断。请核对旧服务/路径状态后人工处理，不会自动重试。", "work-move-manual-note"));
      const copy = textNode("button", "复制任务 ID", "folder-button compact subtle");
      copy.type = "button";
      copy.dataset.workMoveJobId = String(job.id || "");
      copy.dataset.workMoveAction = "copy";
      copy.addEventListener("click", () => copyJobId(job.id));
      actions.append(copy);
    }
    elements.detail.append(head, meta, error, actions);
  }

  function render() {
    const focus = captureJobActionFocus();
    renderSummary();
    renderList();
    renderDetail();
    restoreJobActionFocus(focus);
  }

  function captureJobActionFocus() {
    const active = document.activeElement;
    const inPanel = elements.list?.contains?.(active) || elements.detail?.contains?.(active);
    const jobId = String(active?.dataset?.workMoveJobId || "");
    if (!inPanel || !jobId) return null;
    return { jobId, action: String(active.dataset?.workMoveAction || "card") };
  }

  function jobsIn(container) {
    return [...(container?.querySelectorAll?.("[data-work-move-job-id]") || [])];
  }

  function restoreJobActionFocus(focus) {
    if (!focus) return;
    const matching = (container, action) => jobsIn(container).find((node) => (
      String(node.dataset?.workMoveJobId || "") === focus.jobId
      && String(node.dataset?.workMoveAction || "") === action
    ));
    const target = matching(elements.detail, focus.action)
      || matching(elements.list, focus.action)
      || matching(elements.list, "card");
    target?.focus?.({ preventScroll: true });
  }

  async function performLoad(request) {
    if (!request.quiet) setNotice("正在读取作品迁移任务");
    try {
      const payload = await api(request.path);
      if (request.generation !== state.generation) return;
      state.jobs = payload.jobs || [];
      state.summary = payload.summary || {};
      if (!state.jobs.some((job) => job.id === state.selectedId)) state.selectedId = state.jobs[0]?.id || "";
      render();
      if (!request.quiet) setNotice(`已读取 ${state.jobs.length} 条任务`);
    } catch (error) {
      if (request.generation === state.generation) setNotice(error.message || "读取作品迁移任务失败");
    }
  }

  async function drainLoads(initialRequest) {
    let request = initialRequest;
    try {
      while (request) {
        queuedLoad = null;
        await performLoad(request);
        request = queuedLoad;
      }
    } finally {
      state.loading = false;
      activeLoad = null;
    }
  }

  function load({ quiet = false } = {}) {
    if (!root) return Promise.resolve();
    const request = { generation: ++state.generation, path: queryPath(), quiet };
    if (state.loading) {
      queuedLoad = request;
      return activeLoad;
    }
    state.loading = true;
    activeLoad = drainLoads(request);
    return activeLoad;
  }

  async function retryJob(job, button) {
    button.disabled = true;
    setNotice(`正在重试 ${job.id}`);
    try {
      await api(`/api/work-move-jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST" });
      await load();
    } catch (error) {
      setNotice(error.message || "重试失败");
    } finally {
      button.disabled = false;
    }
  }

  async function copyJobId(jobId) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(jobId);
        setNotice(`已复制 ${jobId}`);
        return;
      } catch {}
    }
    try {
      setNotice(fallbackCopyText(jobId) ? `已复制 ${jobId}` : `无法自动复制，请手动复制：${jobId}`);
    } catch {
      setNotice(`无法自动复制，请手动复制：${jobId}`);
    }
  }

  elements.refresh?.addEventListener("click", () => load());
  elements.status?.addEventListener("change", () => load());
  elements.workId?.addEventListener("change", () => load());
  return { load, render, state };
}

function formatAge(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export { ACTIVE_STATUSES };
