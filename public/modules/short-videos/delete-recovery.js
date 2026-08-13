const DEFAULT_POLL_DELAY_MS = 1400;
const PENDING_STATUSES = new Set(["running", "cleanup_pending", "rollback_pending"]);
const TERMINAL_STATUSES = new Set(["completed", "rolled_back"]);

export function createShortVideoDeleteRecoveryController(options = {}) {
  const api = options.api;
  if (typeof api !== "function") throw new TypeError("delete recovery api is required");
  const setTimer = options.setTimer || ((action, delay) => globalThis.setTimeout(action, delay));
  const clearTimer = options.clearTimer || ((timer) => globalThis.clearTimeout(timer));
  const renderState = options.renderState || createDeleteRecoveryRenderer(options.documentRef || globalThis.document);
  const pollDelayMs = Math.max(0, Number(options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS) || 0);
  let disposed = false;
  let generation = 0;
  let pollTimer = null;
  let active = null;

  function track(result) {
    if (disposed || !result) return snapshot();
    const token = ++generation;
    cancelPoll();
    if (!result.pending) {
      active = null;
      renderState(null);
      return null;
    }
    active = {
      token,
      jobId: requireJobId(result.jobId),
      kind: result.committed ? "cleanup" : "rollback",
      cleanupPendingFiles: nonNegativeInteger(result.cleanupPendingFiles, 0),
      recoverable: false,
      recovering: false,
      error: "",
      terminal: false
    };
    render();
    schedulePoll(token);
    return snapshot();
  }

  async function pollNow() {
    const current = active;
    if (!current || current.terminal || disposed) return snapshot();
    const { token, jobId } = current;
    cancelPoll();
    try {
      const payload = await api(`/api/short-videos/delete-jobs?jobId=${encodeURIComponent(jobId)}`);
      if (!isCurrent(token, jobId)) return snapshot();
      applyJob(parseShortVideoDeleteJob(payload, jobId), token);
    } catch (error) {
      if (!isCurrent(token, jobId)) return snapshot();
      active.error = `状态读取失败，将继续重试：${errorMessage(error, "网络错误")}`;
      render();
      schedulePoll(token);
    }
    return snapshot();
  }

  async function recover() {
    const current = active;
    if (!current || current.terminal || !current.recoverable || current.recovering || disposed) return snapshot();
    const { token, jobId } = current;
    cancelPoll();
    active.recovering = true;
    active.error = "";
    render();
    try {
      const payload = await api("/api/short-videos/delete-jobs", {
        method: "POST",
        body: { jobId }
      });
      if (!isCurrent(token, jobId)) return snapshot();
      applyJob(parseShortVideoDeleteJob(payload, jobId), token);
    } catch (error) {
      if (!isCurrent(token, jobId)) return snapshot();
      active.recovering = false;
      active.error = `恢复失败：${errorMessage(error, "请稍后重试")}`;
      render();
      schedulePoll(token);
    }
    return snapshot();
  }

  function dismiss() {
    if (disposed) return;
    generation += 1;
    cancelPoll();
    active = null;
    renderState(null);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    cancelPoll();
    active = null;
    renderState(null);
  }

  function hasPending() {
    return Boolean(active && !active.terminal);
  }

  function applyJob(job, token) {
    if (!isCurrent(token, job.id)) return;
    if (job.status === "completed") {
      active = {
        ...active,
        recoverable: false,
        recovering: false,
        error: "",
        terminal: true,
        terminalMessage: `短视频文件已安全清理完成（任务 #${job.id}）`
      };
      cancelPoll();
      render();
      return;
    }
    if (job.status === "rolled_back") {
      active = {
        ...active,
        recoverable: false,
        recovering: false,
        error: "",
        terminal: true,
        terminalMessage: `删除未生效，文件已安全恢复（任务 #${job.id}）`
      };
      cancelPoll();
      render();
      return;
    }
    active.kind = job.status === "cleanup_pending" || job.phase === "cleanup" ? "cleanup"
      : job.status === "rollback_pending" || job.phase === "rollback" ? "rollback"
        : active.kind;
    active.recoverable = job.recoverable;
    active.recovering = false;
    active.error = job.error;
    render();
    schedulePoll(token);
  }

  function schedulePoll(token) {
    if (!active || active.terminal || !isCurrent(token, active.jobId)) return;
    cancelPoll();
    pollTimer = setTimer(() => pollNow(), pollDelayMs);
  }

  function cancelPoll() {
    if (pollTimer == null) return;
    clearTimer(pollTimer);
    pollTimer = null;
  }

  function render() {
    if (!active || disposed) return renderState(null);
    const message = active.terminal ? active.terminalMessage : pendingMessage(active);
    renderState({
      ...snapshot(),
      message,
      actionLabel: active.terminal ? "知道了" : active.recoverable ? (active.recovering ? "恢复中" : "重试恢复") : "",
      action: active.terminal ? dismiss : active.recoverable && !active.recovering ? recover : null
    });
  }

  function snapshot() {
    return active ? { ...active } : null;
  }

  function isCurrent(token, jobId) {
    return !disposed && active?.token === token && active.jobId === String(jobId || "").trim();
  }

  return { dismiss, dispose, hasPending, pollNow, recover, snapshot, track };
}

export function parseShortVideoDeleteJob(payload, expectedJobId = "") {
  const row = payload?.job;
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("删除恢复接口没有返回任务状态");
  const id = requireJobId(row.id);
  const expected = String(expectedJobId || "").trim();
  if (expected && id !== expected) throw new Error("删除恢复接口返回了其他任务");
  const status = String(row.status || "").trim();
  if (!PENDING_STATUSES.has(status) && !TERMINAL_STATUSES.has(status)) throw new Error("删除恢复接口返回了未知状态");
  if (typeof row.pending !== "boolean" || row.pending !== PENDING_STATUSES.has(status)) {
    throw new Error("删除恢复任务状态与 pending 不一致");
  }
  if (row.recoverable != null && typeof row.recoverable !== "boolean") throw new Error("删除恢复任务 recoverable 无效");
  if (row.requiresAttention != null && typeof row.requiresAttention !== "boolean") throw new Error("删除恢复任务 requiresAttention 无效");
  const recoverable = row.recoverable === true;
  if (!row.pending && recoverable) throw new Error("已结束的删除恢复任务不能声明可恢复");
  return {
    id,
    status,
    phase: String(row.phase || "").trim(),
    pending: row.pending,
    recoverable,
    requiresAttention: row.requiresAttention === true,
    error: String(row.error || "").trim()
  };
}

function pendingMessage(state) {
  const base = state.kind === "cleanup"
    ? `资料库记录已移除，正在安全清理${state.cleanupPendingFiles > 0 ? `${state.cleanupPendingFiles} 个文件` : "文件"}（任务 #${state.jobId}）`
    : `删除尚未生效，正在安全恢复（任务 #${state.jobId}）`;
  return state.error ? `${base}\n${state.error}` : base;
}

function createDeleteRecoveryRenderer(documentRef) {
  let element = null;
  return (state) => {
    if (!documentRef?.body) return;
    if (!state) {
      element?.remove();
      element = null;
      return;
    }
    if (!element?.isConnected) {
      element = documentRef.createElement("section");
      element.className = "short-video-delete-recovery";
      element.setAttribute("role", "status");
      element.setAttribute("aria-live", "polite");
      const text = documentRef.createElement("span");
      text.className = "short-video-delete-recovery-text";
      const action = documentRef.createElement("button");
      action.type = "button";
      action.className = "short-video-delete-recovery-action";
      element.append(text, action);
      documentRef.body.append(element);
    }
    const text = element.querySelector(".short-video-delete-recovery-text");
    const action = element.querySelector(".short-video-delete-recovery-action");
    text.textContent = state.message;
    action.textContent = state.actionLabel;
    action.hidden = !state.actionLabel;
    action.disabled = typeof state.action !== "function";
    action.onclick = typeof state.action === "function" ? () => state.action() : null;
    element.classList.toggle("is-error", Boolean(state.error));
    element.classList.toggle("is-terminal", Boolean(state.terminal));
  };
}

function requireJobId(value) {
  const id = String(value || "").trim();
  if (!id) throw new Error("删除恢复任务缺少 ID");
  return id;
}

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function errorMessage(error, fallback) {
  return String(error?.message || "").trim() || fallback;
}
