import { fetchJson } from "../../../../js/api.js?v=20260706-mobile-web-sync-01";
import { clearCachedJsonByPrefix } from "../../../../js/cache.js?v=20260812-android-integrated-01";

const ACTIVE_STATUSES = new Set(["queued", "running", "cleanup_pending", "rollback_pending"]);
const TERMINAL_STATUSES = new Set(["blocked", "failed", "rolled_back", "completed"]);

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
  return job?.status !== "blocked" && (job?.status === "failed" || job?.status === "rolled_back");
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

  function baseUrl() {
    return String(getActiveUrl?.() || "").replace(/\/+$/u, "");
  }

  function storageKey(workId) {
    return workMoveRequestStorageKey(baseUrl(), workId);
  }

  function readStored(workId) {
    try {
      const raw = window.localStorage?.getItem(storageKey(workId));
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed?.jobId || parsed?.idempotencyKey ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeStored(workId, value) {
    try {
      window.localStorage?.setItem(storageKey(workId), JSON.stringify(value));
    } catch {}
  }

  function clearStored(workId) {
    try {
      window.localStorage?.removeItem(storageKey(workId));
    } catch {}
  }

  function cleanupRetryKey(jobId) {
    return `${storageKey(attached?.work?.id || "")}.cleanup.${encodeURIComponent(String(jobId || ""))}`;
  }

  function cleanupAlreadyRetried(jobId) {
    try {
      return window.localStorage?.getItem(cleanupRetryKey(jobId)) === "1";
    } catch {
      return false;
    }
  }

  function markCleanupRetried(jobId) {
    try {
      window.localStorage?.setItem(cleanupRetryKey(jobId), "1");
    } catch {}
  }

  function isCurrent(token) {
    return token === generation && attached?.baseUrl === baseUrl();
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
    syncButtons();
    try {
      const job = await restoreJob(normalizedWork, controller.signal);
      if (!isCurrent(token) || !isActive()) return;
      applyJob(job);
      if (job && ACTIVE_STATUSES.has(job.status)) void pollJob(token, controller.signal);
      if (job?.status === "completed") await completeJob(token, job);
    } catch (error) {
      if (!isAbort(error) && isCurrent(token) && isActive()) {
        renderMessage(`迁移状态暂时无法读取：${safeError(error, "请稍后重试")}`, "quiet", false);
      }
    }
  }

  function detach() {
    generation += 1;
    pollController?.abort();
    pollController = null;
    attached?.unlinkActive?.();
    attached?.controller?.abort();
    attached = null;
    syncButtons();
  }

  async function restoreJob(work, signal) {
    const stored = readStored(work.id);
    let job = null;
    if (stored?.jobId) {
      try {
        job = (await request(baseUrl(), `/api/work-move-jobs/${encodeURIComponent(stored.jobId)}`, { signal })).job || null;
      } catch (error) {
        if (Number(error?.status || 0) !== 404) throw error;
      }
    }
    if (!job) {
      const query = stored?.idempotencyKey ? `?idempotencyKey=${encodeURIComponent(stored.idempotencyKey)}` : "";
      job = (await request(baseUrl(), `/api/works/${encodeURIComponent(work.id)}/move-job${query}`, { signal })).job || null;
    }
    if (!job && stored) clearStored(work.id);
    return job;
  }

  function applyJob(job) {
    if (!attached) return;
    attached.job = job || null;
    if (job?.id) {
      const previous = readStored(attached.work.id) || {};
      writeStored(attached.work.id, { ...previous, jobId: job.id });
    }
    syncButtons();
  }

  async function pollJob(token, signal) {
    pollController?.abort();
    const controller = new AbortController();
    pollController = controller;
    const unlink = linkAbort(signal, controller);
    try {
      while (isCurrent(token) && attached?.isActive?.() && ACTIVE_STATUSES.has(attached?.job?.status)) {
        let job = attached.job;
        if (workMoveNeedsCleanupRetry(job) && !cleanupAlreadyRetried(job.id)) {
          markCleanupRetried(job.id);
          job = (await request(baseUrl(), `/api/work-move-jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST", signal: controller.signal })).job || job;
          if (!isCurrent(token)) return;
          applyJob(job);
        }
        await delay(850, controller.signal);
        const payload = await request(baseUrl(), `/api/work-move-jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal });
        if (!isCurrent(token)) return;
        applyJob(payload.job || null);
        if (attached?.job?.status === "completed") await completeJob(token, attached.job);
      }
    } catch (error) {
      if (!isAbort(error) && isCurrent(token)) {
        renderMessage(`迁移状态暂时无法刷新：${safeError(error, "请稍后重试")}`, "quiet", false);
      }
    } finally {
      unlink();
      if (pollController === controller) pollController = null;
    }
  }

  async function completeJob(token, job) {
    if (!isCurrent(token) || !attached || job?.status !== "completed") return;
    clearStored(attached.work.id);
    try {
      await clearDetailCache(baseUrl(), `/api/works/${encodeURIComponent(attached.work.id)}`);
    } catch {}
    if (!isCurrent(token) || !attached?.isActive?.()) return;
    renderMessage("迁移已完成，正在刷新作品资料。", "quiet", false);
    renderWorkDetail(attached.work.id);
  }

  async function openAction() {
    const work = attached?.work;
    const job = attached?.job;
    if (!work) return;
    if (!job) return openMoveTargetPicker(work);
    openMoveStatusSheet(work, job);
  }

  async function openForWork(work) {
    if (attached?.work?.id === String(work?.id || "")) return openAction();
    return openMoveTargetPicker(work);
  }

  async function openMoveTargetPicker(work) {
    if (!work?.id || work.missingLocal) return;
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
    panel.append(title, help, search, result);
    overlay.append(backdrop, panel);
    let requestController = null;
    const close = () => {
      requestController?.abort();
      overlay.remove();
      trigger?.focus?.();
    };
    backdrop.addEventListener("click", close);
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    document.body.append(overlay);
    search.focus();

    let searchTimer = 0;
    const load = async () => {
      requestController?.abort();
      requestController = new AbortController();
      result.textContent = "正在读取允许的目标人物…";
      try {
        const query = search.value.trim();
        const payload = await request(baseUrl(), `/api/works/${encodeURIComponent(work.id)}/move-targets?query=${encodeURIComponent(query)}&limit=36`, {
          signal: requestController.signal
        });
        if (!overlay.isConnected) return;
        renderTargetCandidates(result, payload?.candidates, async (candidate) => {
          close();
          await startMove(work, candidate);
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

  function openMoveStatusSheet(work, job) {
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
    const title = document.createElement("strong");
    title.textContent = `迁移状态：${workMoveStatusLabel(job.status)}`;
    const detail = document.createElement("p");
    detail.className = "work-move-status-detail";
    detail.textContent = job.error || "任务记录保存在服务端；返回或重启后会继续显示。";
    panel.append(title, detail);
    const close = () => {
      overlay.remove();
      trigger?.focus?.();
    };
    if (workMoveCanManualRetry(job)) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "fanhao-sort-option";
      retry.textContent = "重新尝试迁移";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          const payload = await request(baseUrl(), `/api/work-move-jobs/${encodeURIComponent(job.id)}/retry`, { method: "POST" });
          applyJob(payload.job || job);
          close();
          void pollJob(generation, attached?.controller?.signal);
        } catch (error) {
          retry.disabled = false;
          detail.textContent = `恢复失败：${safeError(error, "请稍后重试")}`;
        }
      });
      panel.append(retry);
    }
    overlay.append(backdrop, panel);
    backdrop.addEventListener("click", close);
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") close();
    });
    document.body.append(overlay);
    panel.querySelector("button:not(:disabled)")?.focus();
  }

  async function startMove(work, candidate) {
    const target = normalizeMoveTargetCandidate(candidate);
    if (!target || !work?.id) return;
    const title = work.title || work.directoryName || work.id;
    if (!window.confirm(`确认将「${title}」迁移到「${target.name}」？\n\n服务端会先写入可恢复任务，再处理文件；此操作可能需要一段时间。`)) return;
    const previous = readStored(work.id);
    const idempotencyKey = previous?.idempotencyKey || createIdempotencyKey();
    writeStored(work.id, { idempotencyKey, targetId: target.id });
    try {
      const payload = await request(baseUrl(), `/api/works/${encodeURIComponent(work.id)}/move-to-person`, {
        method: "POST",
        body: { personId: target.id, idempotencyKey }
      });
      const job = payload?.job || null;
      if (!job?.id) throw new Error("服务没有返回迁移任务");
      applyJob(job);
      renderMessage(`已创建迁移任务：${target.name}。`, "quiet", false);
      void pollJob(generation, attached?.controller?.signal);
    } catch (error) {
      try {
        const recovered = await request(baseUrl(), `/api/works/${encodeURIComponent(work.id)}/move-job?idempotencyKey=${encodeURIComponent(idempotencyKey)}`);
        if (recovered?.job) {
          applyJob(recovered.job);
          renderMessage("已恢复服务端迁移任务。", "quiet", false);
          void pollJob(generation, attached?.controller?.signal);
          return;
        }
      } catch {}
      clearStored(work.id);
      renderMessage(`迁移任务未创建：${safeError(error, "请稍后重试")}`, "error", false);
    }
  }

  return { attach, createActionButton, detach, openForWork, openMoveTargetPicker, startMove };
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
