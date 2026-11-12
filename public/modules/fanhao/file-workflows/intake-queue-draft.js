const STORAGE_KEY = "fanhao.intake.wash-queue.v1";
const RESTORE_CONCURRENCY = 3;

export function intakeDraftPathKey(value) {
  const path = String(value || "");
  return /^[a-z]:[/\\]|^(?:\\\\|\/\/)/i.test(path) ? path.replaceAll("\\", "/").toLowerCase() : path;
}

function cleanEntry(entry) {
  if (typeof entry?.path !== "string" || !entry.path) return null;
  return {
    path: entry.path,
    code: typeof entry.code === "string" ? entry.code.slice(0, 40) : "",
    size: Number.isSafeInteger(entry.size) && entry.size > 0 ? entry.size : null,
    packageFolder: typeof entry.packageFolder === "string" ? entry.packageFolder : "",
    jobId: typeof entry.jobId === "string" ? entry.jobId : ""
  };
}

export function readIntakeQueueDraft() {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}");
    const entries = Array.isArray(value.entries) ? value.entries.map(cleanEntry).filter(Boolean) : [];
    const selected = typeof value.selected === "string" ? value.selected : "";
    return { entries, selected };
  } catch { return { entries: [], selected: "" }; }
}

export function saveIntakeQueueDraft(draft) {
  try {
    if (draft.entries.length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* The queue remains usable for the current page. */ }
}

export function mergeIntakeQueueDraft(draft, queue, selected, jobs) {
  const running = new Map(jobs.filter((job) => job.active && !["mark", "discardLibraryVideo"].includes(job.action))
    .map((job) => [intakeDraftPathKey(job.source), String(job.id)]));
  const entries = new Map(draft.entries.map((item) => [intakeDraftPathKey(item.path), item]));
  for (const item of queue) {
    if (item.library || !item.path) continue;
    const key = intakeDraftPathKey(item.path);
    entries.set(key, cleanEntry({
      path: item.path, code: item.code, size: item.size,
      packageFolder: item.package?.folder, jobId: running.get(key)
    }));
  }
  const savedSelection = entries.has(intakeDraftPathKey(selected)) ? selected : draft.selected;
  return { entries: [...entries.values()], selected: savedSelection };
}

export function intakeDraftJobOwns(entry, jobs) {
  const source = intakeDraftPathKey(entry.path), folder = intakeDraftPathKey(entry.packageFolder);
  return jobs.some((job) => !["mark", "discardLibraryVideo"].includes(job.action)
    && (intakeDraftPathKey(job.source) === source || folder && intakeDraftPathKey(job.package?.folder) === folder)
    && (job.active || ["committed", "interrupted", "blocked"].includes(job.state)
      || entry.jobId && String(job.id) === entry.jobId && job.state === "completed"));
}

export async function restoreIntakeQueueDraft(entries, { scan, hasJob, signal }) {
  const outcomes = [];
  let next = 0;
  async function readNext() {
    while (!signal.aborted && next < entries.length) {
      const index = next++, entry = entries[index];
      if (hasJob(entry)) {
        outcomes[index] = { entry, skipped: true };
        continue;
      }
      try {
        const result = await scan(entry.packageFolder || entry.path);
        const item = (result.items || []).find((candidate) => !candidate.library && (entry.packageFolder
          ? intakeDraftPathKey(candidate.package?.folder) === intakeDraftPathKey(entry.packageFolder)
          : intakeDraftPathKey(candidate.path) === intakeDraftPathKey(entry.path)));
        if (!item || item.error) throw new Error(item?.error || "未找到这份视频或下载包。");
        if (entry.code && entry.size && entry.size === item.size && !entry.packageFolder) item.code = entry.code;
        outcomes[index] = { entry, item };
      } catch (error) {
        outcomes[index] = { entry, error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(entries.length, RESTORE_CONCURRENCY) }, readNext));
  return outcomes;
}
