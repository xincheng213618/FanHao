import { createApiClient } from "../../../js/api.js";
const api = createApiClient();
const prefix = "/api/fanhao/file-workflows";
const $ = (id) => document.getElementById(id);
const labels = { preview: "待确认", running: "执行中", stopping: "停止中", interrupted: "已中断", blocked: "需要检查", completed: "已完成" };
const phases = { planned: "待处理", copying: "复制中", copied: "已校验", published: "清理源文件", done: "已完成" };
let selected = null, timer = null, busy = false, revision = 0;
const size = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1073741824 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1073741824).toFixed(2)} GB`;
function node(tag, text, className = "") { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; }
function notice(text, error = false) { $("notice").textContent = text; $("notice").classList.toggle("error", error); }
function render(job) {
  const wasActive = selected?.id === job.id && ["running", "stopping"].includes(selected.status);
  selected = job;
  const active = ["running", "stopping"].includes(job.status);
  $("statusBadge").textContent = labels[job.status] || job.status;
  $("planTitle").textContent = job.kind === "organize" ? "按番号整理" : "保持结构迁移";
  $("totalFiles").textContent = job.totalFiles;
  $("totalBytes").textContent = size(job.totalBytes);
  $("skippedFiles").textContent = job.skippedFiles;
  $("progress").max = Math.max(1, job.totalFiles); $("progress").value = job.completedFiles;
  $("progressText").textContent = `${job.completedFiles} / ${job.totalFiles} 个文件已完成 · ${labels[job.status] || job.status}`;
  $("execute").disabled = busy || active || job.status === "completed" || !job.totalFiles;
  $("execute").textContent = ["interrupted", "blocked"].includes(job.status) ? "检查后继续执行" : "确认并执行";
  $("stop").disabled = job.status !== "running";
  const fragment = document.createDocumentFragment();
  for (const item of job.items || []) {
    const row = document.createElement("tr"), source = document.createElement("td");
    source.append(node("span", item.source.split(/[\\/]/).at(-1), "file-name"), node("span", item.source, "file-path"));
    row.append(source, node("td", item.target), node("td", size(item.bytes)), node("td", item.reason || phases[item.phase] || item.phase, item.reason ? "skip" : item.phase === "done" ? "done" : "")); fragment.append(row);
  }
  if (!job.items?.length) { const row = document.createElement("tr"), cell = node("td", "此目录没有可列出的文件。", "empty"); cell.colSpan = 4; row.append(cell); fragment.append(row); }
  $("files").replaceChildren(fragment);
  notice(job.error || (job.status === "preview" ? `预览已生成。将处理 ${job.totalFiles} 个文件，${job.skippedFiles} 项保留原位。` : job.status === "completed" ? "计划已完成。已入库作品请使用作品迁移流程维护数据库。" : "文件执行进度会自动更新。"), Boolean(job.error));
  clearTimeout(timer);
  if (active) timer = setTimeout(() => loadJob(job.id, true), 1500);
  else if (wasActive) loadHistory();
}
async function loadJob(id, quiet = false) {
  const generation = ++revision;
  try { const { job } = await api(`${prefix}/${id}`); if (generation === revision) render(job); }
  catch (error) { if (generation !== revision) return; notice(error.message, true); if (quiet) timer = setTimeout(() => loadJob(id, true), 3000); }
}
async function loadHistory() {
  try {
    const { jobs } = await api(prefix); const fragment = document.createDocumentFragment();
    for (const job of jobs) {
      const button = node("button", "", "history-item"); button.type = "button";
      const description = document.createElement("span");
      description.append(node("strong", `${job.kind === "organize" ? "番号整理" : "目录迁移"} · ${job.totalFiles} 个文件`), node("small", `${job.source} → ${job.target}`));
      button.append(description, node("span", labels[job.status] || job.status, "status"));
      button.addEventListener("click", () => { if (!busy) loadJob(job.id); }); fragment.append(button);
    }
    $("history").replaceChildren(fragment);
    if (!jobs.length) $("history").append(node("p", "还没有文件计划。生成一次预览后，会在这里保留记录。", "muted"));
  } catch (error) { $("history").replaceChildren(node("p", error.message, "notice error")); }
}
$("planForm").addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return;
  busy = true; revision++; clearTimeout(timer); $("preview").disabled = true; $("execute").disabled = true; selected = null;
  notice("正在扫描目录并检查冲突…");
  try {
    const body = Object.fromEntries(new FormData(event.currentTarget));
    const { job } = await api(`${prefix}/preview`, { method: "POST", body }); busy = false; render(job); await loadHistory();
  } catch (error) { notice(error.message, true); }
  finally { busy = false; $("preview").disabled = false; }
});
$("execute").addEventListener("click", () => {
  if (!selected || busy) return;
  $("confirm").dataset.jobId = selected.id; $("confirm").returnValue = "cancel";
  $("confirmText").textContent = `源目录：${selected.source}。目标目录：${selected.target}。共 ${selected.totalFiles} 个可处理文件，${size(selected.totalBytes)}。`;
  $("confirm").showModal();
});
$("confirm").addEventListener("close", async () => {
  if ($("confirm").returnValue !== "run" || busy) return;
  const id = $("confirm").dataset.jobId; busy = true; $("execute").disabled = true;
  try { const { job } = await api(`${prefix}/${id}/run`, { method: "POST" }); busy = false; revision++; render(job); await loadHistory(); }
  catch (error) { notice(error.message, true); }
  finally {
    busy = false;
    if (selected) $("execute").disabled = ["running", "stopping", "completed"].includes(selected.status) || !selected.totalFiles;
  }
});
$("stop").addEventListener("click", async () => {
  if (!selected) return;
  try { const { job } = await api(`${prefix}/${selected.id}/stop`, { method: "POST" }); render(job); }
  catch (error) { notice(error.message, true); }
});
$("refresh").addEventListener("click", () => { loadHistory(); if (selected) loadJob(selected.id); });
window.addEventListener("pagehide", () => { clearTimeout(timer); revision++; });
try {
  const config = await api(`${prefix}/config`);
  $("allowedRoots").replaceChildren(...config.roots.map((root) => node("li", root)));
} catch (error) { notice(error.message, true); $("preview").disabled = true; }
await loadHistory();
