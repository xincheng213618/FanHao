import { $, escapeHtml } from "../core/dom.js";
import { formatDateTime } from "../core/format.js";

const JOB_STATUS_LABELS = Object.freeze({
  queued: "排队中",
  running: "执行中",
  complete: "已完成",
  failed: "失败",
  stopped: "已停止",
});

const JOB_TYPE_LABELS = Object.freeze({
  extract: "主页采集",
  refresh: "批量采集",
  following: "关注列表提取",
  download: "视频下载",
});

const EVENT_LEVEL_LABELS = Object.freeze({
  info: "信息",
  warn: "警告",
  error: "错误",
  success: "完成",
});

export function createActivityFeature() {
  function bind() {}

  function render(state = {}) {
    const jobs = Array.isArray(state.jobs) ? state.jobs : [];
    const extract = state.extract && typeof state.extract === "object" ? state.extract : {};
    const jobsById = new Map(jobs.map((job) => [jobKey(job.id), job]));
    const runningIds = new Set();
    const queuedIds = new Set();
    const runningItems = [];
    const queuedItems = [];

    if (extract.active && extract.current) {
      const request = extract.current;
      const id = jobKey(request.job_id);
      runningIds.add(id);
      runningItems.push({
        job: mergeRequestJob(jobsById.get(id), request, "running"),
        request,
        forceStatus: "running",
      });
    }

    for (const job of jobs) {
      const id = jobKey(job.id);
      if (job.status !== "running" || runningIds.has(id)) continue;
      runningIds.add(id);
      runningItems.push({ job, request: null, forceStatus: "running" });
    }

    const extractQueue = Array.isArray(extract.queue) ? extract.queue : [];
    extractQueue.forEach((request, index) => {
      const id = jobKey(request.job_id);
      queuedIds.add(id);
      queuedItems.push({
        job: mergeRequestJob(jobsById.get(id), request, "queued"),
        request,
        forceStatus: "queued",
        queuePosition: index + 1,
      });
    });

    for (const job of jobs) {
      const id = jobKey(job.id);
      if (job.status !== "queued" || queuedIds.has(id)) continue;
      queuedIds.add(id);
      queuedItems.push({
        job,
        request: null,
        forceStatus: "queued",
        queuePosition: queuedItems.length + 1,
      });
    }

    const historyItems = jobs
      .filter((job) => {
        const id = jobKey(job.id);
        return !runningIds.has(id)
          && !queuedIds.has(id)
          && !["running", "queued"].includes(String(job.status || ""));
      })
      .map((job) => ({ job, request: null }));

    renderJobList("activityRunning", runningItems, "当前没有正在执行的任务");
    renderJobList("activityQueue", queuedItems, "采集队列为空");
    renderJobList("activityHistory", historyItems, "暂无历史任务");
    setCount("activityRunningCount", runningItems.length);
    setCount("activityQueueCount", queuedItems.length);
    setCount("activityHistoryCount", historyItems.length);
    renderEvents(Array.isArray(state.events) ? state.events : []);
  }

  return { bind, render };
}

function mergeRequestJob(job, request, fallbackStatus) {
  return {
    id: request?.job_id,
    type: request?.type || "",
    status: fallbackStatus,
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    message: request?.label || "",
    started_at: "",
    finished_at: "",
    ...(job || {}),
  };
}

function renderJobList(id, items, emptyText) {
  const node = $(id);
  if (!node) return;
  node.innerHTML = items.length
    ? items.map(renderJobCard).join("")
    : '<div class="activity-empty">' + escapeHtml(emptyText) + "</div>";
}

function renderJobCard(item = {}) {
  const job = item.job || {};
  const request = item.request || {};
  const status = String(item.forceStatus || job.status || "unknown").toLowerCase();
  const statusClass = jobStatusClass(status);
  const title = String(request.label || jobTypeLabel(job.type) || "后台任务");
  const message = String(job.message || "").trim();
  const meta = jobMeta(job, request);
  const progress = renderJobProgress(job);
  const time = jobTime(job, status);
  const queuePosition = Number(item.queuePosition || 0);
  const statusText = queuePosition > 0
    ? "等待第 " + queuePosition + " 个"
    : jobStatusLabel(status);

  return [
    '<article class="activity-job-card is-', statusClass, '">',
      '<div class="activity-job-head">',
        '<div class="activity-job-title-row">',
          '<span class="activity-job-title">', escapeHtml(title), "</span>",
          '<span class="activity-job-id">#', escapeHtml(job.id || ""), "</span>",
        "</div>",
        '<span class="activity-status is-', statusClass, '">', escapeHtml(statusText), "</span>",
      "</div>",
      meta ? '<div class="activity-job-meta">' + escapeHtml(meta) + "</div>" : "",
      message ? '<div class="activity-job-message">' + escapeHtml(message) + "</div>" : "",
      progress,
      time ? '<div class="activity-job-time">' + escapeHtml(time) + "</div>" : "",
    "</article>",
  ].join("");
}

function renderJobProgress(job = {}) {
  const total = nonNegative(job.total);
  const processed = nonNegative(job.processed);
  const success = nonNegative(job.success);
  const failed = nonNegative(job.failed);
  if (!total && !processed && !success && !failed) return "";
  const percent = total > 0 ? Math.max(0, Math.min(100, processed / total * 100)) : 0;
  const primary = total > 0
    ? "进度 " + processed + " / " + total + "（" + Math.round(percent) + "%）"
    : "已处理 " + processed;
  const result = ["成功 " + success, "失败 " + failed].join(" · ");
  return [
    '<div class="activity-progress-summary">',
      "<span>", escapeHtml(primary), "</span>",
      "<span>", escapeHtml(result), "</span>",
    "</div>",
    total > 0
      ? '<div class="activity-progress-track" role="progressbar" aria-label="任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'
        + Math.round(percent)
        + '"><span style="width:'
        + percent.toFixed(1)
        + '%"></span></div>'
      : "",
  ].join("");
}

function jobMeta(job = {}, request = {}) {
  const values = [jobTypeLabel(job.type)];
  const profileIds = Array.isArray(request.profile_ids) ? request.profile_ids : [];
  if (profileIds.length) values.push(profileIds.length + " 个主页");
  else if (Number(job.profile_id || 0) > 0) values.push("主页 #" + Number(job.profile_id));
  if (request.full_scan === true) values.push("全量采集");
  return values.filter(Boolean).join(" · ");
}

function jobTime(job = {}, status = "") {
  const startedAt = String(job.started_at || "");
  const finishedAt = String(job.finished_at || "");
  const started = startedAt ? formatDateTime(startedAt) : "";
  const finished = finishedAt ? formatDateTime(finishedAt) : "";
  const values = [];
  if (status === "queued" && started) values.push("排队于 " + started);
  else if (started) values.push("开始于 " + started);
  if (finished) values.push("结束于 " + finished);
  const duration = elapsedLabel(startedAt, finishedAt || (status === "running" ? new Date().toISOString() : ""));
  if (duration) values.push((status === "running" ? "已运行 " : "耗时 ") + duration);
  return values.join(" · ");
}

function renderEvents(events) {
  const node = $("events");
  if (!node) return;
  setCount("activityEventCount", events.length);
  node.innerHTML = events.length
    ? events.map((event) => {
        const level = eventLevelClass(event.level);
        return [
          '<article class="activity-event-item is-', level, '">',
            '<div class="activity-event-title">', escapeHtml(eventLevelLabel(event.level)), "</div>",
            "<div>", escapeHtml(event.message || ""), "</div>",
            '<div class="activity-event-time">', escapeHtml(formatDateTime(event.ts || "")), "</div>",
          "</article>",
        ].join("");
      }).join("")
    : '<div class="activity-empty">暂无事件日志</div>';
}

function setCount(id, value) {
  const node = $(id);
  if (node) node.textContent = String(nonNegative(value));
}

function jobStatusLabel(value) {
  const key = String(value || "").toLowerCase();
  return JOB_STATUS_LABELS[key] || key || "未知状态";
}

function jobStatusClass(value) {
  const key = String(value || "").toLowerCase();
  return Object.hasOwn(JOB_STATUS_LABELS, key) ? key : "unknown";
}

function jobTypeLabel(value) {
  const key = String(value || "").toLowerCase();
  return JOB_TYPE_LABELS[key] || key || "后台任务";
}

function eventLevelLabel(value) {
  const key = String(value || "").toLowerCase();
  return EVENT_LEVEL_LABELS[key] || key || "日志";
}

function eventLevelClass(value) {
  const key = String(value || "").toLowerCase();
  return ["warn", "error"].includes(key) ? key : "info";
}

function jobKey(value) {
  return String(value ?? "");
}

function nonNegative(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function elapsedLabel(startValue, endValue) {
  const start = Date.parse(String(startValue || ""));
  const end = Date.parse(String(endValue || ""));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return seconds + " 秒";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + " 分 " + (seconds % 60) + " 秒";
  const hours = Math.floor(minutes / 60);
  return hours + " 小时 " + (minutes % 60) + " 分";
}
