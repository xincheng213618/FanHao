import { createApiClient } from "../../../js/api.js";
import { createPhotoCoverWarmPanel } from "./cover-warm-panel.js";

const api = createApiClient();
const { format: formatNumber } = new Intl.NumberFormat("zh-CN");
const warm = createPhotoCoverWarmPanel({ api, formatNumber });
document.querySelector("#cover-warm").append(warm.element);
void warm.refresh();

const scanEndpoint = "/api/photo-maintenance/index";
const scanStart = document.querySelector("#scan-start");
const scanStatus = document.querySelector("#scan-status");
const scanProgress = document.querySelector("#scan-progress");
const scanLog = document.querySelector("#scan-log");
const scanLogText = document.querySelector("#scan-log-text");
const progressPrefix = "IMAGE_LIBRARY_PROGRESS ";
const scanLabels = { running: "正在刷新", stopping: "正在停止", stopped: "已中断", done: "刷新完成", error: "刷新失败" };
let scanTimer, scanBusy = false, scanTask = null;

function latestProgress(logs) {
  for (const line of logs.slice().reverse()) {
    if (!line.startsWith(progressPrefix)) continue;
    try { return JSON.parse(line.slice(progressPrefix.length)); } catch { /* Try the previous complete line. */ }
  }
  return null;
}

async function updateScan(method = "GET") {
  if (scanBusy) return;
  scanBusy = true;
  window.clearTimeout(scanTimer);
  scanStart.disabled = true;
  let canManage = true;
  try {
    ({ task: scanTask } = await api(scanEndpoint, { method, cache: "no-store" }));
    const logs = scanTask?.logs || [];
    const progress = latestProgress(logs);
    const label = scanLabels[scanTask?.status] || "暂无刷新任务";
    scanStatus.textContent = progress?.message && scanTask.status === "running" ? `${label} · ${progress.message}` : label;
    scanProgress.hidden = !Number.isFinite(progress?.percent);
    if (!scanProgress.hidden) scanProgress.value = progress.percent;
    scanLog.hidden = logs.length === 0;
    scanLogText.textContent = logs.join("\n");
  } catch (error) {
    canManage = error.status !== 403 && error.status !== 404;
    scanStatus.textContent = error.message || "索引任务读取失败";
  } finally {
    scanBusy = false;
    const running = ["running", "stopping"].includes(scanTask?.status);
    scanStart.disabled = !canManage || running;
    if (canManage) scanTimer = window.setTimeout(updateScan, running ? 1500 : 5000);
  }
}

scanStart.addEventListener("click", () => void updateScan("POST"));
void updateScan();
