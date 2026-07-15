import { post } from "../core/api.js";
import { $, escapeHtml, safeUrl, toast } from "../core/dom.js";
import { displayDouyinId, formatCompact, formatCountdown, formatDateTime } from "../core/format.js";

export function createDownloadsFeature(options) {
  const settings = options.settings;
  const refreshState = options.refreshState;
  let localQueueOrder = [];
  let latestState = null;
  let lastDownloadProfileId = null;

  function renderDownloadGuard(state) {
    const guard = state.download?.failure_guard || {};
    const active = Boolean(guard.active);
    const plannedPause = guard.kind === "cycle_limit";
    const banner = $("downloadGuard");
    banner.hidden = !active;
    $("downloadState").classList.toggle("guard-status", active);
    if (!active) return;

    const resumeAt = formatDateTime(guard.until);
    const countdown = formatCountdown(guard.remaining_seconds);
    const proxy = state.download?.proxy ? `当前代理：${state.download.proxy}` : "当前未配置下载代理";
    $("downloadGuardTitle").textContent = plannedPause ? "下载主动休息中" : "下载保护已暂停";
    $("downloadGuardReason").textContent = guard.reason || "详情接口疑似触发平台保护";
    $("downloadGuardTime").textContent = `预计 ${resumeAt || "稍后"} 自动重试（剩余 ${countdown}）`;
    $("downloadGuardHelp").textContent = plannedPause
      ? "本轮达到安全下载量，系统会自动继续处理剩余队列。"
      : "切换代理 IP 或更新 Cookie 后，可立即重新尝试。";
    $("downloadGuard").title = proxy;
  }

  function renderDownloadCycle(state) {
    const node = $("downloadCycleProgress");
    if (!node) return;
    const cycle = state.download?.cycle || {};
    const completed = Math.max(0, Number(cycle.completed || 0));
    const limit = Math.max(0, Number(cycle.limit || 0));
    const cooldown = Math.max(1, Number(cycle.cooldown_minutes || 30));
    if (limit <= 0) {
      node.innerHTML = '<div class="muted">主动分段已关闭</div>';
      return;
    }
    const percent = Math.min(100, Math.round((completed / limit) * 100));
    node.innerHTML = `
      <div class="download-cycle-head"><span>本轮实际下载</span><strong>${completed} / ${limit}</strong></div>
      <div class="download-cycle-bar"><span style="width:${percent}%"></span></div>
      <div class="muted">达到 ${limit} 后主动休息 ${cooldown} 分钟</div>
    `;
  }

  function renderStats(stats) {
    const rows = [
      ["total", "队列合计"],
      ["pending", "待下载"],
      ["downloading", "下载中"],
      ["downloaded", "已完成"],
      ["failed", "失败"],
    ];
    $("queueStats").innerHTML = rows
      .map(
        ([key, label]) => `
          <div class="queue-stat">
            <span>${label}</span>
            <strong>${stats[key] || 0}</strong>
          </div>
        `
      )
      .join("");
  }

  function statsFromQueue(queue) {
    return (queue || []).reduce(
      (acc, item) => {
        acc.total += Number(item.total || 0);
        acc.pending += Number(item.pending || 0);
        acc.downloading += Number(item.downloading || 0);
        acc.downloaded += Number(item.downloaded || 0);
        acc.failed += Number(item.failed || 0);
        return acc;
      },
      { total: 0, pending: 0, downloading: 0, downloaded: 0, failed: 0 }
    );
  }

  function renderQueue(queue, activeProfileId) {
    const node = $("downloadQueue");
    if (!node) return;
    const rows = queue || [];
    node.innerHTML =
      rows
        .map((item, index) => {
          const name = String(item.nickname || item.title || `作者 #${item.profile_id}`).trim();
          const tabLabel = item.tab === "like" ? "我的喜欢" : "作者作品";
          const douyinId = displayDouyinId(item);
          const pending = Number(item.pending || 0);
          const downloading = Number(item.downloading || 0);
          const downloaded = Number(item.downloaded || 0);
          const failed = Number(item.failed || 0);
          const total = Number(item.total || 0);
          const active = downloading > 0 || (activeProfileId && Number(item.profile_id) === Number(activeProfileId));
          const stateLabel = downloading > 0 || active ? "下载中" : pending > 0 ? "待下载" : failed > 0 ? "有失败" : "已完成";
          const progress = total > 0 ? Math.round((downloaded / total) * 100) : 0;
          const details = [
            `${total} 总`,
            `${pending} 待`,
            `${downloading} 下`,
            `${downloaded} 完成`,
            failed ? `${failed} 失败` : "",
            item.aweme_count ? `主页 ${formatCompact(item.aweme_count)} 作品` : "",
            douyinId ? `抖音号 ${escapeHtml(douyinId)}` : "",
          ].filter(Boolean).join(" / ");
          return `
            <div class="queue-item ${active ? "active" : ""}">
              <div class="queue-rank">${index + 1}</div>
              <div class="queue-main">
                <div class="queue-title-row">
                  <span class="title">${escapeHtml(name || tabLabel)}</span>
                  <span class="queue-chip">${tabLabel}</span>
                  <span class="queue-chip ${active ? "active" : ""}">${stateLabel}</span>
                  <span class="queue-progress">${progress}%</span>
                </div>
                <div class="muted">${details}</div>
              </div>
              <div class="queue-actions">
                <a class="queue-link" href="${safeUrl(item.url)}" target="_blank" rel="noreferrer">主页</a>
                <button data-queue-move="top" data-profile-id="${escapeHtml(item.profile_id || "")}" ${index === 0 ? "disabled" : ""}>置顶</button>
                <button data-queue-move="up" data-profile-id="${escapeHtml(item.profile_id || "")}" ${index === 0 ? "disabled" : ""}>上移</button>
                <button data-queue-move="down" data-profile-id="${escapeHtml(item.profile_id || "")}" ${index === rows.length - 1 ? "disabled" : ""}>下移</button>
              </div>
            </div>
          `;
        })
        .join("") || '<div class="muted">队列为空</div>';
  }

  function moveLocalQueue(profileId, direction) {
    const id = String(profileId);
    const index = localQueueOrder.indexOf(id);
    if (index < 0) return;
    if (direction === "top") {
      localQueueOrder.splice(index, 1);
      localQueueOrder.unshift(id);
      return;
    }
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= localQueueOrder.length) return;
    [localQueueOrder[index], localQueueOrder[target]] = [localQueueOrder[target], localQueueOrder[index]];
  }

  function queueFromProfiles(profiles) {
    const rows = (profiles || [])
      .filter((profile) => Number(profile.pending || 0) > 0 || Number(profile.downloading || 0) > 0)
      .map((profile) => ({
        profile_id: profile.id,
        url: profile.url,
        tab: profile.tab,
        title: profile.title,
        nickname: profile.nickname,
        short_id: profile.short_id,
        unique_id: profile.unique_id,
        aweme_count: profile.aweme_count,
        total: profile.total || 0,
        pending: profile.pending || 0,
        downloading: profile.downloading || 0,
        downloaded: profile.downloaded || 0,
        failed: profile.failed || 0,
      }));
    if (!localQueueOrder.length) return rows;
    const order = new Map(localQueueOrder.map((id, index) => [String(id), index]));
    return rows.sort((a, b) => {
      const left = order.has(String(a.profile_id)) ? order.get(String(a.profile_id)) : Number.MAX_SAFE_INTEGER;
      const right = order.has(String(b.profile_id)) ? order.get(String(b.profile_id)) : Number.MAX_SAFE_INTEGER;
      return left - right;
    });
  }

  function activeDownloadProfileId(state) {
    const direct = state.download?.profile_id;
    if (direct) {
      lastDownloadProfileId = direct;
      return direct;
    }
    const runningJob = (state.jobs || []).find((job) => job.type === "download" && job.status === "running" && job.profile_id);
    if (runningJob?.profile_id) {
      lastDownloadProfileId = runningJob.profile_id;
      return runningJob.profile_id;
    }
    if (state.download?.active && lastDownloadProfileId) return lastDownloadProfileId;
    if (!state.download?.active) lastDownloadProfileId = null;
    return null;
  }

  async function startDownload(retryFailed = false) {
    await settings.save();
    const result = await post("/api/download/start", {
      concurrency: $("concurrency").value,
      retry_failed: retryFailed,
      limit: 0,
      watch_new: $("watchQueue").checked,
    });
    const mode = result.watch_new ? "动态监听" : `本次 ${result.run_total} 条`;
    toast(`下载任务已启动：${mode}，待处理 ${result.pending} 条`);
  }

  async function sortQueueByPending() {
    const result = await post("/api/download-queue/sort", { mode: "pending_asc" });
    toast(`队列已按待下载数量排序：${result.changed || 0} 个作者`);
    refreshState().catch(() => {});
  }

  async function quitApplication() {
    const busy = Boolean(latestState?.extract?.active || latestState?.download?.active);
    if (busy && !window.confirm("采集或下载仍在进行。退出后未完成任务会在下次启动时继续，确定退出吗？")) return;
    await post("/api/app/quit");
    document.body.innerHTML = `
      <main class="quit-screen">
        <section>
          <div class="eyebrow">Douyin Tool</div>
          <h1>下载管理器已退出</h1>
          <p>后台服务已经停止，现在可以关闭这个浏览器标签页。</p>
        </section>
      </main>
    `;
    window.setTimeout(() => window.close(), 250);
  }

  function bind() {
    $("quitApp").addEventListener("click", () => quitApplication().catch((err) => toast(err.message)));
    $("downloadStart").addEventListener("click", () => startDownload(false).catch((err) => toast(err.message)));
    $("downloadStop").addEventListener("click", () =>
      post("/api/download/stop").then(() => toast("正在停止下载")).catch((err) => toast(err.message))
    );
    $("sortQueueByPending").addEventListener("click", () => sortQueueByPending().catch((err) => toast(err.message)));
    $("downloadQueue").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const profileId = button.dataset.profileId;
      if (!profileId) return;
      if (button.dataset.queueMove) {
        if (!Array.isArray(latestState?.download_queue)) {
          moveLocalQueue(profileId, button.dataset.queueMove);
          refreshState().catch((err) => toast(err.message));
          return;
        }
        post("/api/download-queue/move", { profile_id: profileId, direction: button.dataset.queueMove })
          .then(() => refreshState())
          .catch((err) => toast(err.message));
      }
    });
  }

  function render(state) {
    latestState = state;
    $("quitApp").hidden = !(state.app?.desktop || state.app?.frozen);
    const profiles = state.profiles || [];
    const hasServerQueue = Array.isArray(state.download_queue);
    const queue = hasServerQueue ? state.download_queue : queueFromProfiles(profiles);
    if (!localQueueOrder.length && queue.length) localQueueOrder = queue.map((item) => String(item.profile_id));
    const activeProfileId = activeDownloadProfileId(state);
    renderQueue(queue, activeProfileId);
    renderStats(statsFromQueue(queue));
    const guard = state.download?.failure_guard || {};
    renderDownloadGuard(state);
    renderDownloadCycle(state);
    $("downloadStart").textContent = guard.active
      ? guard.kind === "cycle_limit" ? "提前继续" : "更换 IP 后立即重试"
      : "开始 / 继续";
    if (state.download?.active) {
      const inflight = state.download.inflight ?? state.download.processes ?? 0;
      const watch = state.download.watch_new ? " · 动态监听" : "";
      const port = state.download.sidecar_port ? ` · sidecar:${state.download.sidecar_port}` : "";
      const proxy = state.download.proxy ? ` · 代理:${state.download.proxy}` : "";
      $("downloadState").textContent = `下载中 · ${inflight} 个任务${watch}${port}${proxy}`;
    } else if (guard.active) {
      const minutes = Math.max(1, Math.ceil(Number(guard.remaining_seconds || 0) / 60));
      const proxy = state.download?.proxy ? ` · 代理:${state.download.proxy}` : "";
      const pauseLabel = guard.kind === "cycle_limit" ? "主动休息" : "下载保护暂停";
      $("downloadState").textContent = `${pauseLabel} · ${minutes} 分钟后自动重试${proxy}`;
    } else {
      const proxy = state.download?.proxy ? ` · 代理:${state.download.proxy}` : "";
      $("downloadState").textContent = state.download?.sidecar_port
        ? `下载空闲 · sidecar:${state.download.sidecar_port}${proxy}`
        : `下载空闲${proxy}`;
    }
  }

  return { bind, render };
}
