import { $, escapeHtml } from "../core/dom.js";

export function createActivityFeature() {
  function renderJobs(jobs) {
    $("jobs").innerHTML =
      jobs
        .map(
          (job) => `
            <div class="list-item">
              <div class="title">#${escapeHtml(job.id || "")} ${escapeHtml(job.type || "")} · ${escapeHtml(job.status || "")}</div>
              <div class="muted">${escapeHtml(job.message || "")}</div>
              <div class="muted">${escapeHtml(job.started_at || "")}${job.finished_at ? ` -> ${escapeHtml(job.finished_at)}` : ""}</div>
            </div>
          `
        )
        .join("") || '<div class="muted">暂无任务</div>';
  }

  function renderEvents(events) {
    $("events").innerHTML =
      events
        .map(
          (event) => `
            <div class="list-item">
              <div class="title">${escapeHtml(event.level || "")}</div>
              <div>${escapeHtml(event.message || "")}</div>
              <div class="muted">${escapeHtml(event.ts || "")}</div>
            </div>
          `
        )
        .join("") || '<div class="muted">暂无事件</div>';
  }

  function bind() {}

  function render(state) {
    renderJobs(state.jobs || []);
    renderEvents(state.events || []);
  }

  return { bind, render };
}
