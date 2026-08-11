import { fetchJson } from "../../../../js/api.js?v=20260706-mobile-web-sync-01";
import { clearCachedJsonByPrefix } from "../../../../js/cache.js?v=20260812-android-work-move-02";

const ACTIVE_STATUSES = new Set(["queued", "running", "cleanup_pending", "rollback_pending"]);

export function workMoveStatusLabel(status) {
  return ({
    queued: "等待开始",
    running: "正在迁移",
    cleanup_pending: "等待清理",
    rollback_pending: "正在回滚",
    blocked: "需要人工处理",
    failed: "迁移失败",
    rolled_back: "已回滚",
    completed: "已完成"
  })[String(status || "")] || "迁移状态未知";
}

export function workMoveNeedsCleanupRetry(job) {
  return job?.status === "cleanup_pending" && job?.retryRequired === true && Boolean(String(job?.id || "").trim());
}

export function workMoveCanManualRetry(job) {
  return job?.status !== "blocked" && (job?.status === "failed" || job?.status === "rolled_back" || workMoveNeedsCleanupRetry(job));
}

export function workMoveRequestStorageKey(baseUrl, workId) {
  return `fanhao.android.work-move.${encodeURIComponent(String(baseUrl || "").replace(/\/+$/u, ""))}.${encodeURIComponent(String(workId || ""))}`;
}

export function normalizeMoveTargetCandidate(candidate) {
  const id = String(candidate?.id || "").trim();
  const name = String(candidate?.name || "").trim();
  return id && name ? { id, name } : null;
}

export function createAndroidWorkMoveController({
  getActiveUrl,
  renderMessage = () => {},
  renderWorkDetail = () => {},
  request = fetchJson,
  clearDetailCache = clearCachedJsonByPrefix,
  delay = (ms, signal) => abortableDelay(ms, signal)
} = {}) {
  let attached = null;
  let generation = 0;
  let pollController = null;
  const buttons = new Set();
  const overlayClosers = new Set();

  function trackOverlay(close) {
    overlayClosers.add(close);
    return () => overlayClosers.delete(close);
  }

  function baseUrl() {
    return String(getActiveUrl?.() || "").replace(/\/+$/u, "");
  }

  function captureScope(work) {
    return {
      baseUrl: attached?.baseUrl || baseUrl(),
      generation,
      workId: String(work?.id || "").trim()
    };
  }

  function isCurrent(scope) {
    return Boolean(scope?.workId)
      && scope.generation === generation
      && attached?.baseUrl === scope.baseUrl
      && String(attached?.work?.id || "") === scope.workId
      && attached?.controller?.signal?.aborted !== true
      && attached?.isActive?.() !== false
      && baseUrl() === scope.baseUrl;
  }

  function storageKey(scope) {
    return workMoveRequestStorageKey(scope?.baseUrl || "", scope?.workId || "");
  }

  function readStored(scope) {
    try {
      const raw = window.localStorage?.getItem(storageKey(scope));
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed?.jobId || parsed?.idempotencyKey ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeStored(scope, value) {
    try {
      window.localStorage?.setItem(storageKey(scope), JSON.stringify(value));
    } catch {}
  }

  function clearStored(scope) {
    try {
      window.localStorage?.removeItem(storageKey(scope));
    } catch {}
  }

  function cleanupRetryKey(scope, jobId) {
    return `${storageKey(scope)}.cleanup.${encodeURIComponent(String(jobId || ""))}`;
  }

  function cleanupAlreadyRetried(scope, jobId) {
    try {
      return window.localStorage?.getItem(cleanupRetryKey(scope, jobId)) === "1";
    } catch {
      return false;
    }
  }

  function markCleanupRetried(scope, jobId) {
    try {
      window.localStorage?.setItem(cleanupRetryKey(scope, jobId), "1");
    } catch {}
  }

  function jobMatchesScope(job, scope) {
    return !job || String(job.workId || "") === String(scope?.workId || "");
  }

  function createActionButton(work) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "work-move-action";
    button.dataset.workMoveAction = String(work?.id || "");
    button.addEventListener("click", () => {
      if (attached?.work?.id === String(work?.id || "")) void openAction();
      else void openMoveTargetPicker(work);
    });
    buttons.add(button);
    syncButton(button, work, attached?.work?.id === String(work?.id || "") ? attached?.job : null);
    return button;
  }

  function syncButtons() {
    for (const button of [...buttons]) {
      if (!button.isConnected) {
        buttons.delete(button);
        continue;
      }
      syncButton(button, attached?.work, attached?.job);
    }
  }

  function syncButton(button, work, job) {
    const available = Boolean(work?.id && !work?.missingLocal);
    button.hidden = !available;
    button.disabled = !available;
    if (!available) return;
    if (!job) {
      button.textContent = "迁移作品";
      button.title = "选择服务端允许的人物文件夹并发起安全迁移";
      return;
    }
    button.textContent = job.status === "completed" ? "迁移已完成" : `迁移 · ${workMoveStatusLabel(job.status)}`;
    button.title = job.error || "查看迁移任务状态";
  }

  async function attach(work, { isActive = () => true } = {}) {
    detach();
    const normalizedWork = work?.id && !work?.missingLocal ? work : null;
    if (!normalizedWork) return;
    const token = ++generation;
    const controller = new AbortController();
    const unlinkActive = linkAbort(isActive.signal, controller);
    attached = { work: normalizedWork, job: null, baseUrl: baseUrl(), controller, isActive, unlinkActive };
    const scope = { baseUrl: attached.baseUrl, generation: token, workId: String(normalizedWork.id) };
    syncButtons();
    try {
      const job = await restoreJob(scope, controller.signal);
      if (!isCurrent(scope) || !isActive()) return;
      applyJob(scope, job);
      if (job && ACTIVE_STATUSES.has(job.status)) void pollJob(scope, controller.signal);
      if (job?.status === "completed") await completeJob(scope, job);
    } catch (error) {
      if (!isAbort(error) && isCurrent(scope) && isActive()) {
        attached.unresolvedRecovery = true;
        renderMessage(`迁移状态暂时无法读取：${safeError(error, "请稍后重试")}`, "quiet", false);
      }
    }
  }

  function detach() {
    generation += 1;
    for (const close of [...overlayClosers]) close();
    pollController?.abort();
    pollController = null;
    attached?.unlinkActive?.();
    attached?.controller?.abort();
    attached = null;
    syncButtons();
  }

  function handleBack() {
    const close = [...overlayClosers].at(-1);
    if (!close) return false;
    close();
    return true;
  }

  async function restoreJob(scope, signal) {
    const stored = readStored(scope);
    let job = null;
    if (stored?.jobId) {
      try {
        job = (await request(scope.baseUrl, `/api/work-move-jobs/${encodeURIComponent(stored.jobId)}`, { signal })).job || null;
        if (!jobMatchesScope(job, scope)) job = null;
      } catch (error) {
        if (Number(error?.status || 0) !== 404) throw error;
      }
    }
    if (!job) {
      const query = stored?.idempotencyKey ? `?idempotencyKey=${encodeURIComponent(stored.idempotencyKey)}` : "";
      job = (await request(scope.baseUrl, `/api/works/${encodeURIComponent(scope.workId)}/move-job${query}`, { signal })).job || null;
      if (!jobMatchesScope(job, scope)) job = null;
    }
    if (!job && stored && isCurrent(scope)) clearStored(scope);
    return job;
  }

  function applyJob(scope, job) {
    if (!isCurrent(scope) || !jobMatchesScope(job, scope)) return false;
    attached.job = job || null;
    if (job?.id) {
      const previous = readStored(scope) || {};
      writeStored(scope, { ...previous, jobId: job.id });
    }
    syncButtons();
    return true;
  }

  async function pollJob(scope, signal) {
    pollController?.abort();
    const controller = new AbortController();
    pollController = controller;
    const unlink = linkAbort(signal, controller);
    try {
      while (isCurrent(scope) && attached?.isActive?.() && ACTIVE_STATUSES.has(attached?.job?.status)) {
        let job = attached.job;
        if (!jobMatchesScope(job, scope)) return;
        if (workMoveNeedsCleanupRetry(job) && !cleanupAlreadyRetried(scope, job.id)) {
          job = (await request(scope.baseUrl, `/api/work-move-jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST", signal: controller.signal })).job || job;
          if (!isCurrent(scope) || !jobMatchesScope(job, scope)) return;
          markCleanupRetried(scope, job.id);
          applyJob(scope, job);
        }
        await delay(850, controller.signal);
        const payload = await request(scope.baseUrl, `/api/work-move-jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal });
        if (!isCurrent(scope) || !jobMatchesScope(payload.job, scope)) return;
        applyJob(scope, payload.job || null);
        if (attached?.job?.status === "completed") await completeJob(scope, attached.job);
      }
    } catch (error) {
      if (!isAbort(error) && isCurrent(scope)) {
        renderMessage(`迁移状态暂时无法刷新：${safeError(error, "请稍后重试")}`, "quiet", false);
      }
    } finally {
      unlink();
      if (pollController === controller) pollController = null;
    }
  }

  async function completeJob(scope, job) {
    if (!isCurrent(scope) || !attached || !jobMatchesScope(job, scope) || job?.status !== "completed") return;
    clearStored(scope);
    try {
      await clearDetailCache(scope.baseUrl, `/api/works/${encodeURIComponent(scope.workId)}`);
    } catch {}
    if (!isCurrent(scope) || !attached?.isActive?.()) return;
    renderMessage("迁移已完成，正在刷新作品资料。", "quiet", false);
    renderWorkDetail(scope.workId);
  }

  async function openAction() {
    const work = attached?.work;
    const job = attached?.job;
    const scope = captureScope(work);
    if (!work || !isCurrent(scope)) return;
    if (!job && attached?.unresolvedRecovery) {
      renderMessage("迁移状态尚未确认，已保留恢复标识；请先恢复连接后再操作。", "quiet", false);
      return;
    }
    if (!job) return openMoveTargetPicker(work);
    openMoveStatusSheet(work, job, scope);
  }

  async function openForWork(work) {
    if (attached?.work?.id === String(work?.id || "")) return openAction();
    return openMoveTargetPicker(work);
  }

  async function openMoveTargetPicker(work) {
    if (!work?.id || work.missingLocal) return;
    const scope = captureScope(work);
    if (!isCurrent(scope)) return;
    for (const close of [...overlayClosers]) close();
    const trigger = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "fanhao-sort-overlay work-move-target-overlay";
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "fanhao-sort-backdrop";
    backdrop.setAttribute("aria-label", "关闭迁移目标选择");
    const panel = document.createElement("section");
    panel.className = "fanhao-sort-sheet work-move-target-sheet";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "workMoveTargetTitle");
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "work-move-dialog-close";
    closeButton.textContent = "关闭";
    closeButton.setAttribute("aria-label", "关闭迁移目标选择");
    const title = document.createElement("strong");
    title.id = "workMoveTargetTitle";
    title.textContent = "选择迁移目标人物";
    const help = document.createElement("p");
    help.className = "work-move-target-help";
    help.textContent = "仅显示服务器确认存在且位于资料库根目录内的人物文件夹。";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索人物名";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "搜索迁移目标人物");
    const result = document.createElement("div");
    result.className = "work-move-target-list";
    result.setAttribute("aria-live", "polite");
    panel.append(closeButton, title, help, search, result);
    overlay.append(backdrop, panel);
    let requestController = null;
    let unlinkRequest = () => {};
    let searchTimer = 0;
    let releaseFocus = () => {};
    let untrack = () => {};
    let unlinkScopeClose = () => {};
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      requestController?.abort();
      unlinkRequest();
      unlinkScopeClose();
      window.clearTimeout(searchTimer);
      releaseFocus();
      untrack();
      overlay.remove();
      trigger?.focus?.();
    };
    untrack = trackOverlay(close);
    unlinkScopeClose = listenAbort(attached?.controller?.signal, close);
    closeButton.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    document.body.append(overlay);
    releaseFocus = installModalFocusTrap({ close, initialFocus: search, panel, trigger });

    const load = async () => {
      requestController?.abort();
      unlinkRequest();
      requestController = new AbortController();
      unlinkRequest = linkAbort(attached?.controller?.signal, requestController);
      result.textContent = "正在读取允许的目标人物…";
      try {
        const candidates = await loadMoveTargets(work, scope, search.value.trim(), requestController.signal);
        if (!overlay.isConnected || !isCurrent(scope)) {
          if (overlay.isConnected) close();
          return;
        }
        renderTargetCandidates(result, candidates, async (candidate) => {
          close();
          await startMove(work, candidate, scope);
        });
      } catch (error) {
        if (isAbort(error) || !overlay.isConnected) return;
        result.textContent = `读取目标失败：${safeError(error, "请稍后重试")}`;
      }
    };
    search.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(load, 180);
    });
    await load();
  }

  async function loadMoveTargets(work, scope = captureScope(work), query = "", signal = undefined) {
    if (!isCurrent(scope)) return null;
    const payload = await request(scope.baseUrl, `/api/works/${encodeURIComponent(scope.workId)}/move-targets?query=${encodeURIComponent(String(query || "").trim())}&limit=36`, { signal });
    return isCurrent(scope) ? payload?.candidates || [] : null;
  }

  function openMoveStatusSheet(work, job, scope = captureScope(work)) {
    if (!isCurrent(scope) || !jobMatchesScope(job, scope)) return;
    for (const close of [...overlayClosers]) close();
    const trigger = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "fanhao-sort-overlay work-move-status-overlay";
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "fanhao-sort-backdrop";
    backdrop.setAttribute("aria-label", "关闭迁移状态");
    const panel = document.createElement("section");
    panel.className = "fanhao-sort-sheet work-move-status-sheet";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "workMoveStatusTitle");
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "work-move-dialog-close";
    closeButton.textContent = "关闭";
    closeButton.setAttribute("aria-label", "关闭迁移状态");
    const title = document.createElement("strong");
    title.id = "workMoveStatusTitle";
    title.textContent = `迁移状态：${workMoveStatusLabel(job.status)}`;
    const detail = document.createElement("p");
    detail.className = "work-move-status-detail";
    detail.textContent = job.error || "任务记录保存在服务端；返回或重启后会继续显示。";
    panel.append(closeButton, title, detail);
    let releaseFocus = () => {};
    let untrack = () => {};
    let unlinkScopeClose = () => {};
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      releaseFocus();
      untrack();
      unlinkScopeClose();
      overlay.remove();
      trigger?.focus?.();
    };
    untrack = trackOverlay(close);
    unlinkScopeClose = listenAbort(attached?.controller?.signal, close);
    closeButton.addEventListener("click", close);
    if (workMoveCanManualRetry(job)) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "fanhao-sort-option";
      retry.textContent = "重新尝试迁移";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          const payload = await request(scope.baseUrl, `/api/work-move-jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST", signal: attached?.controller?.signal });
          if (!isCurrent(scope) || !jobMatchesScope(payload.job, scope)) return;
          applyJob(scope, payload.job || job);
          close();
          void pollJob(scope, attached?.controller?.signal);
        } catch (error) {
          if (!isCurrent(scope)) return close();
          retry.disabled = false;
          detail.textContent = `恢复失败：${safeError(error, "请稍后重试")}`;
        }
      });
      panel.append(retry);
    }
    overlay.append(backdrop, panel);
    backdrop.addEventListener("click", close);
    document.body.append(overlay);
    releaseFocus = installModalFocusTrap({ close, initialFocus: closeButton, panel, trigger });
  }

  async function startMove(work, candidate, scope = captureScope(work)) {
    const target = normalizeMoveTargetCandidate(candidate);
    if (!target || !work?.id || !isCurrent(scope)) return;
    if (attached?.unresolvedRecovery) {
      renderMessage("迁移状态尚未确认，不能创建新任务。", "quiet", false);
      return;
    }
    const title = work.title || work.directoryName || work.id;
    if (!window.confirm(`确认将「${title}」迁移到「${target.name}」？\n\n服务端会先写入可恢复任务，再处理文件；此操作可能需要一段时间。`)) return;
    const previous = readStored(scope);
    if (previous?.idempotencyKey && previous?.targetId && previous.targetId !== target.id) {
      renderMessage("存在尚未确认的迁移请求，不能改选目标人物。", "quiet", false);
      return;
    }
    const idempotencyKey = previous?.idempotencyKey || createIdempotencyKey();
    writeStored(scope, { idempotencyKey, targetId: target.id });
    const signal = attached?.controller?.signal;
    try {
      const payload = await request(scope.baseUrl, `/api/works/${encodeURIComponent(scope.workId)}/move-to-person`, {
        method: "POST",
        body: { personId: target.id, idempotencyKey },
        signal
      });
      const job = payload?.job || null;
      if (!job?.id) throw new Error("服务没有返回迁移任务");
      if (!isCurrent(scope) || !jobMatchesScope(job, scope)) return;
      applyJob(scope, job);
      renderMessage(`已创建迁移任务：${target.name}。`, "quiet", false);
      void pollJob(scope, attached?.controller?.signal);
    } catch (error) {
      if (!isCurrent(scope)) return;
      let confirmedNoJob = false;
      try {
        const recovered = await request(scope.baseUrl, `/api/works/${encodeURIComponent(scope.workId)}/move-job?idempotencyKey=${encodeURIComponent(idempotencyKey)}`, { signal });
        if (recovered?.job && isCurrent(scope) && jobMatchesScope(recovered.job, scope)) {
          applyJob(scope, recovered.job);
          renderMessage("已恢复服务端迁移任务。", "quiet", false);
          void pollJob(scope, attached?.controller?.signal);
          return;
        }
        confirmedNoJob = recovered?.job === null;
      } catch {
        if (isCurrent(scope)) {
          attached.unresolvedRecovery = true;
          renderMessage("迁移请求状态暂时无法确认，已保留恢复标识。", "quiet", false);
        }
        return;
      }
      if (!isCurrent(scope)) return;
      if (confirmedNoJob) clearStored(scope);
      renderMessage(`迁移任务未创建：${safeError(error, "请稍后重试")}`, "error", false);
    }
  }

  return { attach, createActionButton, detach, handleBack, loadMoveTargets, openForWork, openMoveTargetPicker, startMove };
}

function renderTargetCandidates(container, source, select) {
  const candidates = (Array.isArray(source) ? source : []).map(normalizeMoveTargetCandidate).filter(Boolean);
  container.replaceChildren();
  if (!candidates.length) {
    container.textContent = "没有找到可用的人物文件夹，请换一个关键词。";
    return;
  }
  for (const candidate of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fanhao-sort-option work-move-target-option";
    button.textContent = candidate.name;
    button.setAttribute("aria-label", `迁移到 ${candidate.name}`);
    button.addEventListener("click", () => void select(candidate));
    container.append(button);
  }
}

export function installModalFocusTrap({
  close,
  documentRef = document,
  initialFocus = null,
  panel,
  trigger = null
} = {}) {
  const focusable = () => [...(panel?.querySelectorAll?.("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])") || [])]
    .filter((element) => element.offsetParent !== null || element === initialFocus);
  const focusInitial = () => (initialFocus || focusable()[0] || panel)?.focus?.();
  const keydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close?.();
      return;
    }
    if (event.key !== "Tab") return;
    const targets = focusable();
    if (!targets.length) {
      event.preventDefault();
      panel?.focus?.();
      return;
    }
    const current = documentRef.activeElement;
    const index = targets.indexOf(current);
    const next = event.shiftKey
      ? targets[(index <= 0 ? targets.length : index) - 1]
      : targets[(index + 1) % targets.length];
    event.preventDefault();
    next?.focus?.();
  };
  const focusin = (event) => {
    if (!panel?.contains?.(event.target)) focusInitial();
  };
  documentRef.addEventListener("keydown", keydown, true);
  documentRef.addEventListener("focusin", focusin, true);
  focusInitial();
  return () => {
    documentRef.removeEventListener("keydown", keydown, true);
    documentRef.removeEventListener("focusin", focusin, true);
    trigger?.focus?.();
  };
}

function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return `android:${globalThis.crypto.randomUUID()}`;
  return `android:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function linkAbort(signal, controller) {
  if (!signal) return () => {};
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export function listenAbort(signal, callback) {
  if (!signal) return () => {};
  if (signal.aborted) {
    callback?.();
    return () => {};
  }
  const abort = () => callback?.();
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = window.setTimeout(() => {
      signal?.removeEventListener?.("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener?.("abort", abort, { once: true });
  });
}

function isAbort(error) {
  return error?.name === "AbortError" || /请求超时/u.test(String(error?.message || ""));
}

function safeError(error, fallback) {
  const message = String(error?.message || "").trim();
  return message || fallback;
}
