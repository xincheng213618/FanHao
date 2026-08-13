const DEFAULT_POLL_DELAY_MS = 1400;
const PENDING_STORAGE_KEY = "fanhao.short-video.delete.pending.v1";
const PENDING_STORAGE_VERSION = 1;
const PENDING_STATUSES = new Set(["running", "cleanup_pending", "rollback_pending"]);
const TERMINAL_STATUSES = new Set(["completed", "rolled_back"]);

export function createShortVideoDeleteRecoveryController(options = {}) {
  const api = options.api;
  if (typeof api !== "function") throw new TypeError("delete recovery api is required");
  const setTimer = options.setTimer || ((action, delay) => globalThis.setTimeout(action, delay));
  const clearTimer = options.clearTimer || ((timer) => globalThis.clearTimeout(timer));
  const renderState = options.renderState || createDeleteRecoveryRenderer(options.documentRef || globalThis.document);
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage;
  const apiBaseUrl = normalizeApiBase(options.apiBaseUrl || globalThis.location?.origin || "");
  const pollDelayMs = Math.max(0, Number(options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS) || 0);
  let disposed = false;
  let generation = 0;
  let pollTimer = null;
  let active = null;
  let ready;

  function track(result) {
    if (disposed || !result) return snapshot();
    const token = ++generation;
    cancelPoll();
    if (!result.pending) {
      active = null;
      clearStoredPending();
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
      manualIntervention: result.manualInterventionRequired === true,
      processRestartRequired: result.processRestartRequired === true,
      error: "",
      terminal: false
    };
    persistActive();
    render();
    if (!active.manualIntervention) schedulePoll(token);
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
    if (!current || current.terminal || current.manualIntervention || !current.recoverable || current.recovering || disposed) return snapshot();
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
    clearStoredPending();
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
      clearStoredPending();
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
      clearStoredPending();
      cancelPoll();
      render();
      return;
    }
    active.kind = job.status === "cleanup_pending" || job.phase === "cleanup" ? "cleanup"
      : job.status === "rollback_pending" || job.phase === "rollback" ? "rollback"
        : active.kind;
    active.recoverable = job.recoverable;
    active.recovering = false;
    active.manualIntervention = job.manualInterventionRequired || (job.stalled && !job.recoverable);
    active.processRestartRequired = job.processRestartRequired;
    active.error = job.error;
    persistActive();
    render();
    if (!active.manualIntervention) schedulePoll(token);
  }

  function schedulePoll(token) {
    if (!active || active.terminal || active.manualIntervention || !isCurrent(token, active.jobId)) return;
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
      actionLabel: active.terminal ? "知道了" : active.recoverable && !active.manualIntervention ? (active.recovering ? "恢复中" : "重试恢复") : "",
      action: active.terminal ? dismiss : active.recoverable && !active.recovering && !active.manualIntervention ? recover : null
    });
  }

  function snapshot() {
    return active ? { ...active } : null;
  }

  function isCurrent(token, jobId) {
    return !disposed && active?.token === token && active.jobId === String(jobId || "").trim();
  }

  ready = restoreStoredPending();
  return { dismiss, dispose, hasPending, pollNow, ready, recover, snapshot, track };

  async function restoreStoredPending() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(PENDING_STORAGE_KEY);
      if (!raw) return null;
      const pending = parseStoredPendingJob(raw);
      if (!apiBaseUrl || pending.apiBaseUrl !== apiBaseUrl) throw new Error("上次删除任务属于其他服务");
      const token = ++generation;
      active = { token, ...pending, recoverable: false, recovering: false, manualIntervention: false, processRestartRequired: false, error: "", terminal: false };
      return pollNow();
    } catch (error) {
      clearStoredPending();
      renderRestoreNotice(`上次删除恢复状态无效，已安全忽略：${errorMessage(error, "数据损坏")}`);
      return null;
    }
  }

  function persistActive() {
    if (!storage || !active || active.terminal || !apiBaseUrl) return;
    const pending = validateStoredPendingJob({
      version: PENDING_STORAGE_VERSION,
      jobId: active.jobId,
      apiBaseUrl,
      kind: active.kind,
      cleanupPendingFiles: active.cleanupPendingFiles
    });
    try {
      storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(pending));
    } catch (error) {
      active.error = `恢复状态无法保存，请保持当前页面：${errorMessage(error, "存储错误")}`;
    }
  }

  function clearStoredPending() {
    if (!storage) return;
    try { storage.removeItem(PENDING_STORAGE_KEY); } catch {}
  }

  function renderRestoreNotice(message) {
    const clear = () => renderState(null);
    renderState({ terminal: true, error: message, message, actionLabel: "知道了", action: clear });
  }
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
  for (const key of ["manualInterventionRequired", "processRestartRequired", "stalled", "retryable"]) {
    if (row[key] != null && typeof row[key] !== "boolean") throw new Error(`删除恢复任务 ${key} 无效`);
  }
  const recoverable = row.recoverable === true;
  if (!row.pending && recoverable) throw new Error("已结束的删除恢复任务不能声明可恢复");
  return {
    id,
    status,
    phase: String(row.phase || "").trim(),
    pending: row.pending,
    recoverable,
    requiresAttention: row.requiresAttention === true,
    manualInterventionRequired: row.manualInterventionRequired === true,
    processRestartRequired: row.processRestartRequired === true,
    stalled: row.stalled === true,
    retryable: row.retryable === true,
    error: String(row.error || "").trim()
  };
}

function pendingMessage(state) {
  const base = state.kind === "cleanup"
    ? `资料库记录已移除，正在安全清理${state.cleanupPendingFiles > 0 ? `${state.cleanupPendingFiles} 个文件` : "文件"}（任务 #${state.jobId}）`
    : `删除尚未生效，正在安全恢复（任务 #${state.jobId}）`;
  const manual = state.manualIntervention
    ? state.processRestartRequired ? "\n需要人工处理，请重启服务后再恢复。" : "\n需要人工处理，请人工检查后再恢复。"
    : "";
  return state.error ? `${base}${manual}\n${state.error}` : `${base}${manual}`;
}

function parseStoredPendingJob(raw) {
  let row;
  try { row = JSON.parse(raw); } catch { throw new Error("删除恢复记录不是有效 JSON"); }
  return validateStoredPendingJob(row);
}

function validateStoredPendingJob(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("删除恢复记录无效");
  const keys = Object.keys(row).sort();
  const expected = ["apiBaseUrl", "cleanupPendingFiles", "jobId", "kind", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("删除恢复记录结构无效");
  if (row.version !== PENDING_STORAGE_VERSION) throw new Error("删除恢复记录版本无效");
  const jobId = requireJobId(row.jobId);
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(jobId)) throw new Error("删除恢复任务 ID 无效");
  const apiBaseUrl = normalizeApiBase(row.apiBaseUrl);
  if (!apiBaseUrl) throw new Error("删除恢复服务地址无效");
  if (row.kind !== "cleanup" && row.kind !== "rollback") throw new Error("删除恢复任务类型无效");
  if (!Number.isSafeInteger(row.cleanupPendingFiles) || row.cleanupPendingFiles < 0 || row.cleanupPendingFiles > 1_000_000) {
    throw new Error("删除恢复任务待清理数量无效");
  }
  return { version: PENDING_STORAGE_VERSION, jobId, apiBaseUrl, kind: row.kind, cleanupPendingFiles: row.cleanupPendingFiles };
}

function normalizeApiBase(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function safeLocalStorage() {
  try { return globalThis.window?.localStorage || null; } catch { return null; }
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
