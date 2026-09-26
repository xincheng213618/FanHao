import { api, post } from "../core/api.js";
import { $, escapeHtml, safeUrl, toast } from "../core/dom.js";
import { displayDouyinId, formatCompact, formatCountdown, formatDateTime } from "../core/format.js";

export function inferProbeDiagnostic(result) {
  if (result.diagnostic) return result.diagnostic;
  const message = String(result.message || "").replace(/\s+/g, " ").trim();
  if (result.kind === "busy" || message.includes("自动下载正在运行")) {
    return {
      outcome: "not_tested",
      rule: "runtime.busy",
      label: "自动下载运行中",
      detail: "当前监听器正在占用下载 Sidecar，本次没有向抖音发起测试请求。",
      action: "无需处理；发生异常保护暂停后，再用测试按钮验证新的 VPN、代理或 Cookie。",
    };
  }
  const error = String(result.error || "").replace(/\s+/g, " ").trim();
  const lowered = error.toLowerCase();
  const signatureReasons = [
    ["uifid not found", "访客身份缺失", "Cookie 中缺少签名所需的 UIFID；请重新获取 Cookie，切换 VPN 不能补齐它。"],
    ["signature not found", "签名参数缺失", "请求没有携带完整的 WebSign；需要更新签名实现，而不是更换 Cookie。"],
    ["sign invalid", "签名校验失败", "签名已被识别但内容不匹配；检查算法、User-Agent 与已编码 URL 是否保持一致。"],
    ["sign expired", "签名已过期", "检查系统时间，并重新生成签名后再测试。"],
  ];
  for (const [detail, label, action] of signatureReasons) {
    if (lowered.includes(detail)) return { outcome: "risk_control", rule: "signature.refused", label, detail, action };
  }
  if (result.download_ready) {
    return { outcome: "ok", rule: "default.ok", label: "接口正常", detail: "作品详情载荷完整", action: "可以继续下载。" };
  }
  if (result.kind === "login_required") {
    return { outcome: "business_error", rule: "identity.login_required", label: "Cookie 登录失效", detail: "平台要求重新登录", action: "重新登录或导入最新 Cookie 后再测试。" };
  }
  if (!result.transport_ok) {
    return { outcome: "network_error", rule: "network.exception", label: "网络连接失败", detail: error || "没有收到平台响应", action: "检查 VPN、代理、DNS 和本机网络后重新测试。" };
  }
  if ([401, 403, 405, 412, 429, 444].includes(Number(result.http_status))) {
    return { outcome: "risk_control", rule: "http.risk_status", label: Number(result.http_status) === 429 ? "请求频率受限" : "平台拒绝当前请求", detail: `http ${result.http_status}`, action: "检查当前出口、Cookie 和请求指纹；保留原始响应用于继续诊断。" };
  }
  return { outcome: "business_error", rule: "probe.unclassified", label: "接口返回异常", detail: error || result.kind || "unknown", action: "查看原始响应继续诊断。" };
}

export function buildProbePresentation(result) {
  const endpoint = result.endpoint || "/aweme/v1/web/aweme/detail/";
  const status = result.http_status ? `HTTP ${result.http_status}` : "未收到 HTTP 响应";
  const elapsed = Number.isFinite(Number(result.elapsed_ms)) ? ` · ${Number(result.elapsed_ms)} ms` : "";
  const busy = result.kind === "busy" || String(result.message || "").includes("自动下载正在运行");
  if (busy) {
    return {
      summary: result.message || "自动下载正在运行，本次未重复测试接口",
      tone: "is-warning",
      diagnostic: inferProbeDiagnostic(result),
      rawError: "",
    };
  }
  if (result.download_ready) {
    return {
      summary: `测试通过 · ${status}${elapsed} · ${endpoint}`,
      tone: "is-success",
      diagnostic: inferProbeDiagnostic(result),
      rawError: "",
    };
  }
  return {
    summary: `${result.transport_ok ? "已连接抖音，但暂不可下载" : "连接失败"} · ${status}${elapsed} · ${endpoint}`,
    tone: result.transport_ok ? "is-warning" : "is-error",
    diagnostic: inferProbeDiagnostic(result),
    rawError: result.error || "",
  };
}

export function createDownloadsFeature(options) {
  const refreshState = options.refreshState;
  let localQueueOrder = [];
  let latestState = null;
  let latestStatus = null;
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
      : "系统会在保护冷却结束后自动重试；期间可更新代理或 Cookie。";
    $("downloadGuard").title = proxy;
  }

  function renderDownloadCycle(state) {
    const node = $("downloadCycleProgress");
    if (!node) return;
    const cycle = state.download?.cycle || {};
    const completed = Math.max(0, Number(cycle.completed || 0));
    const limit = Math.max(0, Number(cycle.limit || 0));
    const cooldown = Math.max(1, Number(cycle.cooldown_minutes || 30));
    const idleRemaining = Math.max(0, Number(cycle.idle_remaining_seconds || 0));
    if (limit <= 0) {
      node.innerHTML = '<div class="muted">主动分段已关闭</div>';
      return;
    }
    const percent = Math.min(100, Math.round((completed / limit) * 100));
    const resetHint = completed > 0 && idleRemaining > 0
      ? `当前空闲，${formatCountdown(idleRemaining)} 后本轮计数自动清零；下载位置保持不变`
      : `达到 ${limit} 后休息 ${cooldown} 分钟；连续空闲 ${cooldown} 分钟也会从 0 开始新一轮`;
    node.innerHTML = `
      <div class="download-cycle-head"><span>本轮实际下载</span><strong>${completed} / ${limit}</strong></div>
      <div class="download-cycle-bar"><span style="width:${percent}%"></span></div>
      <div class="muted">${resetHint}</div>
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

  function renderQueue(queue, activeProfileId, state) {
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
        .join("") || `
          <div class="queue-empty">
            <strong>当前没有排队主页</strong>
            <span>自动下载持续监听，新链接入库后会直接执行。</span>
          </div>
        `;
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

  async function sortQueueByPending() {
    const result = await post("/api/download-queue/sort", { mode: "pending_asc" });
    toast(`队列已按待下载数量排序：${result.changed || 0} 个作者`);
    refreshState().catch(() => {});
  }

  async function resumeDownloads() {
    const button = $("resumeDownloads");
    const wasGuarded = Boolean(latestStatus?.download?.failure_guard?.active);
    button.disabled = true;
    try {
      await post("/api/download/resume");
      toast(wasGuarded ? "已跳过保护冷却，自动下载已恢复" : "自动下载已恢复");
      await refreshState();
    } finally {
      button.disabled = false;
    }
  }

  function showProbeResult(message, tone = "") {
    const node = $("downloadProbeResult");
    node.hidden = false;
    node.textContent = message;
    node.className = `download-probe-result ${tone}`.trim();
  }

  function showStructuredProbeResult(presentation) {
    const node = $("downloadProbeResult");
    node.hidden = false;
    node.className = `download-probe-result ${presentation.tone}`.trim();
    const diagnostic = presentation.diagnostic;
    const diagnosticHtml = diagnostic
      ? `
          <div class="download-probe-diagnostic">
            <div class="download-probe-tags">
              <span class="download-probe-label">${escapeHtml(diagnostic.label || "未分类异常")}</span>
              <code>${escapeHtml(diagnostic.rule || "probe.unclassified")}</code>
            </div>
            ${diagnostic.detail ? `<div><strong>判定依据：</strong>${escapeHtml(diagnostic.detail)}</div>` : ""}
            ${diagnostic.action ? `<div><strong>建议处理：</strong>${escapeHtml(diagnostic.action)}</div>` : ""}
            ${presentation.rawError ? `<details><summary>原始响应</summary><code class="download-probe-raw">${escapeHtml(presentation.rawError)}</code></details>` : ""}
          </div>
        `
      : "";
    node.innerHTML = `<div class="download-probe-summary">${escapeHtml(presentation.summary)}</div>${diagnosticHtml}`;
  }

  async function testDownloadApi() {
    const button = $("testDownloadApi");
    button.disabled = true;
    showProbeResult("正在使用当前 Cookie、代理和 VPN 测试真实作品详情接口…", "is-running");
    try {
      const result = await api("/api/download/probe");
      showStructuredProbeResult(buildProbePresentation(result));
      if (result.download_ready) {
        toast("作品详情接口测试通过，可以继续下载");
      } else if (result.transport_ok) {
        toast(result.message || "已连接抖音，但作品接口暂不可用");
      } else {
        toast(result.message || "作品详情接口连接失败");
      }
    } catch (error) {
      showProbeResult(`测试失败 · ${error.message}`, "is-error");
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function quitApplication() {
    const busy = Boolean(latestStatus?.extract?.active || latestStatus?.download?.active);
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
    $("testDownloadApi").addEventListener("click", () => testDownloadApi());
    $("resumeDownloads").addEventListener("click", () => resumeDownloads().catch((err) => toast(err.message)));
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

  function renderHome(state) {
    latestState = state;
    const profiles = state.profiles || [];
    const hasServerQueue = Array.isArray(state.download_queue);
    const queue = hasServerQueue ? state.download_queue : queueFromProfiles(profiles);
    if (!localQueueOrder.length && queue.length) localQueueOrder = queue.map((item) => String(item.profile_id));
    const activeProfileId = activeDownloadProfileId(state);
    renderQueue(queue, activeProfileId, state);
    renderStats(statsFromQueue(queue));
  }

  function renderStatus(state) {
    latestStatus = state;
    $("quitApp").hidden = !(state.app?.desktop || state.app?.frozen);
    const guard = state.download?.failure_guard || {};
    const plannedPause = guard.kind === "cycle_limit";
    renderDownloadGuard(state);
    renderDownloadCycle(state);
    const active = Boolean(state.download?.active);
    const inflight = Math.max(0, Number(state.download?.inflight ?? state.download?.processes ?? 0));
    const watching = active && Boolean(state.download?.watch_new);
    const diagnostics = [
      state.download?.sidecar_port ? `sidecar ${state.download.sidecar_port}` : "",
      state.download?.proxy ? `代理 ${state.download.proxy}` : "未配置代理",
    ].filter(Boolean).join(" · ");
    let primaryStatus = "自动下载准备中";
    let nextAction = "程序会自动启动监听，采集到新作品后直接下载";
    let statusClass = "is-idle";
    const resumeButton = $("resumeDownloads");
    const probeButton = $("testDownloadApi");
    resumeButton.hidden = active || plannedPause;
    probeButton.hidden = active || plannedPause;
    resumeButton.textContent = guard.active ? "立即继续下载" : "恢复自动下载";
    resumeButton.title = guard.active ? "跳过本次保护冷却并立即恢复自动下载" : "重新启动自动下载监听";
    if (active && inflight > 0) {
      primaryStatus = `正在下载 · ${inflight} 个任务`;
      nextAction = watching ? "完成当前任务后继续监听新链接" : "正在处理当前下载队列";
      statusClass = "is-active";
    } else if (watching) {
      primaryStatus = "监听中 · 当前空闲";
      nextAction = "等待新链接，发现后会自动下载";
      statusClass = "is-watching";
    } else if (active) {
      primaryStatus = "下载任务准备中";
      nextAction = "正在检查待下载队列";
      statusClass = "is-active";
    } else if (guard.active) {
      const countdown = formatCountdown(guard.remaining_seconds);
      if (guard.kind === "cycle_limit") {
        primaryStatus = "主动休息中";
        nextAction = `预计 ${countdown || "稍后"} 后自动继续`;
        statusClass = "is-resting";
      } else {
        primaryStatus = "异常保护暂停";
        nextAction = "切换 VPN 或更新 Cookie 后，先测试作品接口；通过后再立即继续下载";
        statusClass = "is-warning";
      }
    }

    const downloadState = $("downloadState");
    downloadState.textContent = primaryStatus;
    downloadState.title = diagnostics;
    downloadState.className = statusClass;
    $("downloadPrimaryStatus").textContent = primaryStatus;
    $("downloadNextAction").textContent = nextAction;
    $("downloadRuntimeDetails").textContent = diagnostics;

  }

  function render(state) {
    renderHome(state);
    renderStatus(state);
  }

  return { bind, render, renderHome, renderStatus };
}
