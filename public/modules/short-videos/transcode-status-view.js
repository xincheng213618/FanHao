const PHASE_LABELS = Object.freeze({
  queued: "等待开始",
  preparing: "准备任务",
  probing: "检查源视频",
  transcoding: "FFmpeg 转码中",
  finalizing: "校验并写入缓存",
  completed: "转码完成",
  "source-compatible": "源视频可直放"
});

const RESULT_LABELS = Object.freeze({
  completed: "已完成",
  "source-compatible": "无需转码",
  cached: "已有缓存",
  stopped: "已手动停止",
  skipped: "已跳过",
  failed: "失败"
});

export function createShortVideoTranscodeStatusView({ api, formatBytes }) {
  let root = null;
  let content = null;
  let autoRefreshButton = null;
  let refreshButton = null;
  let pollTimer = 0;
  let refreshing = false;
  let latestData = null;
  let transcodeControlBusy = false;
  let cacheCleanupBusy = false;
  let autoRefreshEnabled = true;
  let pointerInteracting = false;
  let interactionHoldUntil = 0;
  let regions = Object.create(null);
  let regionSignatures = Object.create(null);

  function mount(container) {
    stopPolling();
    regions = Object.create(null);
    regionSignatures = Object.create(null);
    root = document.createElement("section");
    root.className = "short-video-transcode-management";
    root.setAttribute("aria-labelledby", "shortVideoTranscodePageTitle");

    const shell = document.createElement("div");
    shell.className = "short-video-transcode-shell";
    const header = document.createElement("header");
    header.className = "short-video-transcode-header";
    const heading = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "实时后台任务";
    const title = document.createElement("h2");
    title.id = "shortVideoTranscodePageTitle";
    title.textContent = "FFmpeg 转码管理";
    const subtitle = document.createElement("p");
    subtitle.textContent = "查看当前在处理哪条视频、为什么处理，以及队列还剩多少。";
    heading.append(eyebrow, title, subtitle);

    const actions = document.createElement("div");
    const back = document.createElement("a");
    back.className = "short-video-transcode-back";
    back.href = "/short-videos";
    back.textContent = "返回短视频";
    autoRefreshButton = document.createElement("button");
    autoRefreshButton.type = "button";
    autoRefreshButton.className = "short-video-transcode-auto-refresh";
    autoRefreshButton.addEventListener("click", () => {
      autoRefreshEnabled = !autoRefreshEnabled;
      updateAutoRefreshButton();
      if (autoRefreshEnabled) refresh({ force: true });
    });
    refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "short-video-transcode-refresh";
    refreshButton.textContent = "刷新";
    refreshButton.addEventListener("click", () => refresh({ force: true }));
    actions.append(back, autoRefreshButton, refreshButton);
    header.append(heading, actions);

    content = document.createElement("div");
    content.className = "short-video-transcode-content";
    shell.append(header, content);
    root.append(shell);
    root.addEventListener("pointerdown", (event) => {
      if (!content?.contains(event.target)) return;
      pointerInteracting = true;
      updateAutoRefreshButton();
    });
    const finishPointerInteraction = () => {
      if (!pointerInteracting) return;
      pointerInteracting = false;
      interactionHoldUntil = Date.now() + 1500;
      updateAutoRefreshButton();
    };
    window.addEventListener("pointerup", finishPointerInteraction, true);
    window.addEventListener("pointercancel", finishPointerInteraction, true);
    root.addEventListener("toggle", updateAutoRefreshButton, true);
    document.addEventListener("selectionchange", updateAutoRefreshButton);
    container.replaceChildren(root);
    updateAutoRefreshButton();
    if (latestData) renderStatus(latestData);
    else renderLoading();
    updateAutoRefreshButton();
    refresh({ force: true });
    pollTimer = window.setInterval(refresh, 1000);
    return root;
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = 0;
  }

  async function refresh(options = {}) {
    if (!root?.isConnected) {
      stopPolling();
      return;
    }
    if (refreshing) return;
    if (!options.force && isAutoRefreshPaused()) {
      updateAutoRefreshButton();
      return;
    }
    refreshing = true;
    const showBusy = Boolean(options.force);
    if (showBusy) {
      refreshButton.disabled = true;
      refreshButton.textContent = "读取中…";
    }
    try {
      latestData = await api("/api/short-videos/playback-cache-status");
      if (!options.force && isAutoRefreshPaused()) return;
      renderStatus(latestData);
    } catch (error) {
      renderError(error, !latestData);
    } finally {
      refreshing = false;
      if (showBusy) {
        refreshButton.disabled = false;
        refreshButton.textContent = "刷新";
      }
    }
  }

  function renderLoading() {
    if (!content || latestData) return;
    const loading = document.createElement("div");
    loading.className = "short-video-transcode-loading";
    loading.textContent = "正在读取 FFmpeg 后台状态…";
    content.replaceChildren(loading);
  }

  function renderError(error, replace) {
    if (!content) return;
    content.querySelector(".short-video-transcode-error")?.remove();
    const banner = document.createElement("div");
    banner.className = "short-video-transcode-error";
    banner.textContent = error?.message || "转码状态读取失败";
    if (replace) content.replaceChildren(banner);
    else content.prepend(banner);
  }

  function renderStatus(data = {}) {
    const smooth = data.smooth || {};
    const jobs = smooth.activeJobs || (smooth.activeJob ? [smooth.activeJob] : []);
    const queue = smooth.queue || [];
    const pipeline = smooth.pipeline || {};
    const recent = smooth.recent || [];
    const signatures = {
      live: JSON.stringify({
        activeCount: smooth.activeCount,
        active: smooth.active,
        pausedByUser: smooth.pausedByUser,
        jobs: smooth.jobs,
        concurrency: smooth.concurrency,
        maxConcurrency: pipeline.maxConcurrency,
        transcodeControlBusy,
        cacheCleanupBusy
      }),
      overview: JSON.stringify({
        activeCount: smooth.activeCount,
        pausedByUser: smooth.pausedByUser,
        concurrency: smooth.concurrency,
        jobs: smooth.jobs,
        queued: smooth.queued,
        backlog: smooth.backlog,
        scanOffset: smooth.scanOffset,
        warmupCandidates: smooth.warmupCandidates,
        scanComplete: smooth.scanComplete,
        resolved: smooth.resolved
      }),
      current: JSON.stringify({ jobs, pausedByUser: smooth.pausedByUser, queuedJobs: smooth.jobs }),
      queue: JSON.stringify({ queue, queued: smooth.queued, backlog: smooth.backlog }),
      pipeline: JSON.stringify(pipeline),
      recent: JSON.stringify(recent)
    };
    content.querySelector(".short-video-transcode-error")?.remove();
    if (!hasMountedStatusRegions()) {
      const lower = document.createElement("div");
      lower.className = "short-video-transcode-lower-grid";
      regions = {
        live: renderLiveBanner(smooth),
        overview: renderOverview(smooth),
        current: renderCurrentJobs(jobs, smooth),
        queue: renderQueue(queue, smooth),
        pipeline: renderPipeline(pipeline),
        recent: renderRecent(recent),
        lower
      };
      lower.append(regions.queue, regions.pipeline);
      content.replaceChildren(regions.live, regions.overview, regions.current, lower, regions.recent);
      regionSignatures = signatures;
    } else {
      replaceStatusRegion("live", signatures.live, () => renderLiveBanner(smooth));
      replaceStatusRegion("overview", signatures.overview, () => renderOverview(smooth));
      replaceStatusRegion("current", signatures.current, () => renderCurrentJobs(jobs, smooth));
      replaceStatusRegion("queue", signatures.queue, () => renderQueue(queue, smooth));
      replaceStatusRegion("pipeline", signatures.pipeline, () => renderPipeline(pipeline));
      replaceStatusRegion("recent", signatures.recent, () => renderRecent(recent));
      const stamp = regions.live?.querySelector("time");
      if (stamp) stamp.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    }
    updateAutoRefreshButton();
  }

  function hasMountedStatusRegions() {
    return ["live", "overview", "current", "queue", "pipeline", "recent", "lower"]
      .every((name) => regions[name]?.isConnected);
  }

  function replaceStatusRegion(name, signature, create) {
    if (regionSignatures[name] === signature) return;
    const next = create();
    regions[name].replaceWith(next);
    regions[name] = next;
    regionSignatures[name] = signature;
  }

  function renderLiveBanner(smooth) {
    const activeCount = Math.max(0, Number(smooth.activeCount || smooth.activeJobs?.length || (smooth.activeJob ? 1 : 0)));
    const active = activeCount > 0;
    const pausedByUser = Boolean(smooth.pausedByUser);
    const banner = document.createElement("section");
    banner.className = `short-video-transcode-live${pausedByUser ? " is-stopped" : active ? " is-active" : " is-idle"}`;
    const dot = document.createElement("span");
    dot.className = "short-video-transcode-live-dot";
    const copy = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = pausedByUser
      ? active ? "正在停止后台转码" : "后台转码已手动停止"
      : active ? `${activeCount} 个后台任务正在并发转码` : Number(smooth.jobs || 0) ? "任务等待启动" : "当前没有运行中的 FFmpeg";
    const detail = document.createElement("span");
    detail.textContent = pausedByUser
      ? active ? "正在结束当前 FFmpeg 进程" : "点击恢复转码后会继续处理队列"
      : active
      ? `并发上限 ${smooth.concurrency || 1} · 播放不会暂停或延迟转码`
      : Number(smooth.jobs || 0) ? "达到任务启动时间后会自动继续" : "只有实际发生解码错误或持续卡顿的视频才会进入队列";
    copy.append(strong, detail);
    const stamp = document.createElement("time");
    stamp.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    const control = document.createElement("button");
    control.type = "button";
    control.className = `short-video-transcode-run-control${pausedByUser ? " is-resume" : " is-stop"}`;
    control.textContent = transcodeControlBusy ? "处理中…" : pausedByUser ? "恢复转码" : "停止转码";
    control.disabled = transcodeControlBusy;
    control.title = pausedByUser
      ? "恢复后台转码队列"
      : "停止当前 FFmpeg 并暂停后续转码；恢复后当前任务会重新开始";
    control.addEventListener("click", () => controlTranscoding(pausedByUser ? "resume" : "pause"));
    const concurrency = document.createElement("label");
    concurrency.className = "short-video-transcode-concurrency";
    const concurrencyLabel = document.createElement("span");
    concurrencyLabel.textContent = "并发";
    const concurrencySelect = document.createElement("select");
    concurrencySelect.setAttribute("aria-label", "转码并发数");
    const maxConcurrency = Math.max(1, Number(smooth.pipeline?.maxConcurrency || 4));
    for (let value = 1; value <= maxConcurrency; value += 1) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = `${value} 条`;
      option.selected = value === Number(smooth.concurrency || smooth.pipeline?.concurrency || 1);
      concurrencySelect.append(option);
    }
    concurrencySelect.disabled = transcodeControlBusy;
    concurrencySelect.addEventListener("change", () => controlTranscoding("set-concurrency", {
      concurrency: Number(concurrencySelect.value)
    }));
    concurrency.append(concurrencyLabel, concurrencySelect);
    const clearCache = document.createElement("button");
    clearCache.type = "button";
    clearCache.className = "short-video-transcode-cache-clear";
    clearCache.textContent = cacheCleanupBusy ? "清除中…" : "清除转码缓存";
    clearCache.disabled = cacheCleanupBusy || activeCount > 0;
    clearCache.title = clearCache.disabled && !cacheCleanupBusy
      ? "请先停止转码并等待任务退出"
      : "只删除可重新生成的 H.264 流畅版，不会删除源视频";
    clearCache.addEventListener("click", cleanupTranscodeCache);
    banner.append(dot, copy, stamp, concurrency, clearCache, control);
    return banner;
  }

  function renderOverview(smooth) {
    const scanned = Math.max(0, Number(smooth.scanOffset || 0));
    const total = Math.max(0, Number(smooth.warmupCandidates || 0));
    const cards = document.createElement("section");
    cards.className = "short-video-transcode-overview";
    for (const [label, value, detail] of [
      ["当前任务", Number(smooth.activeCount || 0) ? `${formatNumber(smooth.activeCount)} 个运行中` : smooth.pausedByUser ? "已停止" : "空闲", `并发上限 ${smooth.concurrency || 1}`],
      ["已排任务", `${formatNumber(smooth.jobs || 0)} 个`, `${formatNumber(smooth.queued || 0)} 个尚未启动`],
      ["内存候选", `${formatNumber(smooth.backlog || 0)} 条`, "有空位时继续送入队列"],
      ["问题视频", total ? `${formatNumber(scanned)} / ${formatNumber(total)}` : "0", smooth.scanComplete ? "已加载实际播放问题记录" : "按最近问题分批载入"],
      ["本轮已完成", `${formatNumber(smooth.resolved || 0)} 条`, "已经有可复用缓存或无需再处理"]
    ]) cards.append(metricCard(label, value, detail));
    return cards;
  }

  function renderCurrentJobs(jobs, smooth) {
    const activeJobs = Array.isArray(jobs) ? jobs : [];
    const section = document.createElement("section");
    section.className = "short-video-transcode-panel short-video-transcode-current";
    const head = panelHeading("当前处理", activeJobs.length ? `${activeJobs.length} 个独立 FFmpeg 进程与各自输出进度` : "当前没有运行中的转码进程");
    section.append(head);
    if (!activeJobs.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-transcode-empty";
      empty.textContent = smooth.pausedByUser
        ? "后台转码已手动停止。点击上方“恢复转码”后继续处理队列。"
        : Number(smooth.jobs || 0) ? "任务已进入队列，达到启动时间后会继续处理。" : "没有正在处理的任务。";
      section.append(empty);
      return section;
    }
    const grid = document.createElement("div");
    grid.className = "short-video-transcode-active-grid";
    for (const job of activeJobs) grid.append(renderCurrentJobCard(job));
    section.append(grid);
    return section;
  }

  function renderCurrentJobCard(job) {
    const card = document.createElement("article");
    card.className = "short-video-transcode-active-job";
    const identity = document.createElement("div");
    identity.className = "short-video-transcode-job-identity";
    const title = document.createElement("h3");
    title.textContent = job.title || job.source?.fileName || job.id;
    title.title = title.textContent;
    const meta = document.createElement("p");
    meta.textContent = `${job.authorName || "未知作者"} · ID ${job.id}`;
    const chips = document.createElement("div");
    chips.className = "short-video-transcode-chips";
    chips.append(
      chip(jobKindLabel(job.kind), "kind"),
      chip(phaseLabel(job.phase), "phase"),
      chip(job.target?.acceleration || "CPU", "encoder")
    );
    identity.append(title, meta, chips);

    const progress = job.progress || {};
    const progressWrap = document.createElement("div");
    progressWrap.className = "short-video-transcode-progress-wrap";
    const progressHead = document.createElement("div");
    const progressLabel = document.createElement("strong");
    const hasDuration = Number(progress.durationMs || 0) > 0;
    progressLabel.textContent = hasDuration ? `${Number(progress.percent || 0).toFixed(1)}%` : phaseLabel(job.phase);
    const progressDetail = document.createElement("span");
    progressDetail.textContent = hasDuration
      ? `${formatClock(progress.outTimeMs)} / ${formatClock(progress.durationMs)}`
      : `已运行 ${formatDuration(job.elapsedMs)}`;
    progressHead.append(progressLabel, progressDetail);
    const track = document.createElement("div");
    track.className = `short-video-transcode-progress${hasDuration ? "" : " is-indeterminate"}`;
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(2, Math.min(100, Number(progress.percent || 0)))}%`;
    track.append(fill);
    progressWrap.append(progressHead, track);

    const facts = document.createElement("div");
    facts.className = "short-video-transcode-facts";
    facts.append(
      fact("源文件画质", sourceQualityDescription(job.source)),
      fact("流畅版画质", targetQualityDescription(job.source, job.target)),
      fact("速度", Number(progress.speed || 0) ? `${Number(progress.speed).toFixed(2)}x` : "等待 FFmpeg 回报"),
      fact("预计剩余", Number(progress.etaMs || 0) ? formatDuration(progress.etaMs) : "计算中"),
      fact("已写入", formatBytesSafe(progress.outputBytes)),
      fact("已运行", formatDuration(job.elapsedMs))
    );

    const paths = document.createElement("details");
    paths.className = "short-video-transcode-paths";
    const summary = document.createElement("summary");
    summary.textContent = "查看并复制路径（展开时自动暂停更新）";
    paths.append(summary, pathRow("源文件", job.source?.path), pathRow("流畅版", job.target?.path));
    card.append(identity, progressWrap, facts, paths);
    return card;
  }

  function renderQueue(queue, smooth) {
    const section = document.createElement("section");
    section.className = "short-video-transcode-panel";
    section.append(panelHeading("接下来处理", `${formatNumber(smooth.queued || 0)} 个已排任务，另有 ${formatNumber(smooth.backlog || 0)} 条内存候选`));
    const list = document.createElement("div");
    list.className = "short-video-transcode-queue";
    if (!queue.length) {
      const empty = document.createElement("p");
      empty.className = "short-video-transcode-empty";
      empty.textContent = "当前没有已排任务。";
      list.append(empty);
    }
    for (const [index, job] of queue.entries()) {
      const row = document.createElement("div");
      const order = document.createElement("span");
      order.textContent = String(index + 1).padStart(2, "0");
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = job.title || job.source?.fileName || job.id;
      title.title = title.textContent;
      const detail = document.createElement("small");
      detail.textContent = `${jobKindLabel(job.kind)} · 源文件 ${sourceQualityDescription(job.source)}${job.readyInMs > 0 ? ` · ${formatDuration(job.readyInMs)} 后可启动` : ""}`;
      copy.append(title, detail);
      row.append(order, copy);
      list.append(row);
    }
    section.append(list);
    return section;
  }

  function renderPipeline(pipeline) {
    const section = document.createElement("section");
    section.className = "short-video-transcode-panel";
    section.append(panelHeading("这套逻辑在做什么", "后台只生成可复用的流畅播放缓存，不会改动原视频"));
    const steps = document.createElement("ol");
    steps.className = "short-video-transcode-logic";
    for (const text of [
      "所有视频先直接播放源文件；4K、HEVC 或高帧率本身不再被判定为需要转码。",
      "只有浏览器真实出现解码错误、首帧长时间未到或播放持续卡住时，这一条视频才会记录为问题并进入队列。",
      `转码目标是长边不超过 ${pipeline.targetMaxEdge || 2560}px、H.264、${pipeline.targetFrameRate || 30}fps、AAC，当前使用 ${pipeline.acceleration || "CPU"}。`,
      `后台最多并发运行 ${pipeline.concurrency || 1} 个独立 FFmpeg 进程，每个进程内部也会使用多线程和 ${pipeline.acceleration || "CPU"}。播放不会暂停、终止或延迟转码任务。`,
      "结果写入共享缓存，之后 Web 和 Android 播放会直接复用，不会重复转码。"
    ]) {
      const item = document.createElement("li");
      item.textContent = text;
      steps.append(item);
    }
    section.append(steps);
    return section;
  }

  function renderRecent(recent) {
    const section = document.createElement("section");
    section.className = "short-video-transcode-panel short-video-transcode-recent";
    section.append(panelHeading("本次启动后的最近结果", "仅保留内存中的最近 12 条，服务重启后清空"));
    const list = document.createElement("div");
    list.className = "short-video-transcode-recent-list";
    if (!recent.length) {
      const empty = document.createElement("p");
      empty.className = "short-video-transcode-empty";
      empty.textContent = "还没有完成或跳过的任务。";
      list.append(empty);
    }
    for (const job of recent) {
      const row = document.createElement("div");
      row.className = `is-${job.state || "skipped"}`;
      const status = document.createElement("span");
      status.textContent = RESULT_LABELS[job.state] || job.state || "已结束";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = job.title || job.source?.fileName || job.id;
      title.title = title.textContent;
      const detail = document.createElement("small");
      detail.textContent = [job.reason, job.elapsedMs ? `耗时 ${formatDuration(job.elapsedMs)}` : "", job.endedAt ? formatDateTime(job.endedAt) : ""].filter(Boolean).join(" · ");
      copy.append(title, detail);
      const paths = document.createElement("details");
      paths.className = "short-video-transcode-recent-paths";
      const summary = document.createElement("summary");
      summary.textContent = "查看路径";
      const pathList = document.createElement("div");
      pathList.append(pathRow("源文件", job.source?.path), pathRow("流畅版", job.target?.path));
      paths.append(summary, pathList);
      row.append(status, copy, paths);
      list.append(row);
    }
    section.append(list);
    return section;
  }

  function panelHeading(titleText, detailText) {
    const head = document.createElement("header");
    head.className = "short-video-transcode-panel-head";
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.textContent = detailText;
    head.append(title, detail);
    return head;
  }

  function metricCard(labelText, valueText, detailText) {
    const card = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = labelText;
    const value = document.createElement("strong");
    value.textContent = valueText;
    const detail = document.createElement("small");
    detail.textContent = detailText;
    card.append(label, value, detail);
    return card;
  }

  function chip(text, kind) {
    const element = document.createElement("span");
    element.className = `is-${kind}`;
    element.textContent = text;
    return element;
  }

  function fact(labelText, valueText) {
    const item = document.createElement("div");
    const label = document.createElement("span");
    label.textContent = labelText;
    const value = document.createElement("strong");
    value.textContent = valueText;
    item.append(label, value);
    return item;
  }

  function pathRow(labelText, valueText) {
    const row = document.createElement("div");
    row.className = "short-video-transcode-path-row";
    const label = document.createElement("span");
    label.textContent = labelText;
    const code = document.createElement("code");
    code.textContent = valueText || "—";
    code.title = valueText || "";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.disabled = !valueText;
    copy.addEventListener("click", async () => {
      if (!valueText) return;
      interactionHoldUntil = Date.now() + 3000;
      try {
        await copyText(valueText);
        copy.textContent = "已复制";
      } catch {
        copy.textContent = "复制失败";
      }
      window.setTimeout(() => {
        copy.textContent = "复制";
      }, 1600);
      updateAutoRefreshButton();
    });
    row.append(label, code, copy);
    return row;
  }

  function updateAutoRefreshButton() {
    if (!autoRefreshButton) return;
    const interactionPaused = autoRefreshEnabled && isInteractionPaused();
    autoRefreshButton.classList.toggle("is-paused", !autoRefreshEnabled || interactionPaused);
    autoRefreshButton.textContent = !autoRefreshEnabled
      ? "继续更新"
      : interactionPaused ? "交互中已暂停" : "暂停更新";
    autoRefreshButton.title = !autoRefreshEnabled
      ? "恢复每秒更新"
      : interactionPaused ? "选择文字或展开路径期间不会重绘" : "暂停自动更新，便于查看和复制";
  }

  async function controlTranscoding(action, values = {}) {
    if (transcodeControlBusy) return;
    transcodeControlBusy = true;
    const button = content?.querySelector(".short-video-transcode-run-control");
    if (button) {
      button.disabled = true;
      button.textContent = "处理中…";
    }
    let succeeded = false;
    try {
      const result = await api("/api/short-videos/playback-cache-control", {
        method: "POST",
        body: { action, ...values }
      });
      latestData = result?.status || latestData;
      succeeded = true;
    } catch (error) {
      renderError(error, false);
    } finally {
      transcodeControlBusy = false;
      if (succeeded && latestData) renderStatus(latestData);
      else if (button) {
        button.disabled = false;
        button.textContent = action === "pause" ? "停止转码" : action === "resume" ? "恢复转码" : "设置并发";
      }
    }
  }

  async function cleanupTranscodeCache() {
    if (cacheCleanupBusy || !window.confirm("只删除转码生成的流畅版缓存，不会删除源视频。确定清除吗？")) return;
    cacheCleanupBusy = true;
    if (latestData) renderStatus(latestData);
    try {
      const result = await api("/api/short-videos/playback-cache-cleanup", { method: "POST" });
      latestData = result?.status || latestData;
      const bytes = Math.max(0, Number(result?.removed?.removedBytes || 0));
      window.alert(`已清除 ${result?.removed?.removedCount || 0} 个转码缓存，释放 ${formatBytes(bytes)}。`);
    } catch (error) {
      renderError(error, false);
    } finally {
      cacheCleanupBusy = false;
      if (latestData) renderStatus(latestData);
    }
  }

  function isAutoRefreshPaused() {
    return !autoRefreshEnabled || isInteractionPaused();
  }

  function isInteractionPaused() {
    return pointerInteracting
      || Date.now() < interactionHoldUntil
      || Boolean(content?.querySelector("details[open]"))
      || hasDialogSelection();
  }

  function hasDialogSelection() {
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    return root?.contains(selection.getRangeAt(0).commonAncestorContainer) || false;
  }

  function sourceDescription(source = {}) {
    const resolution = source.width && source.height ? `${source.width}×${source.height}` : "分辨率未知";
    const codec = String(source.codec || "").toUpperCase() || "编码未知";
    const frameRate = Number(source.frameRate || 0) ? `${Number(source.frameRate).toFixed(Number(source.frameRate) % 1 ? 1 : 0)}fps` : "帧率未知";
    return `${resolution} · ${codec} · ${frameRate}`;
  }

  function sourceQualityDescription(source = {}) {
    return `${resolutionLabel(source.width, source.height)} · ${sourceDescription(source)}`;
  }

  function targetQualityDescription(source = {}, target = {}) {
    const dimensions = scaledDimensions(source.width, source.height, target.maxEdge || 2560);
    const resolution = dimensions.width && dimensions.height
      ? `${dimensions.width}×${dimensions.height}`
      : `长边 ≤ ${target.maxEdge || 2560}px`;
    return `${resolutionLabel(dimensions.width, dimensions.height)} · ${resolution} · H.264 · ${target.frameRate || 30}fps`;
  }

  function phaseLabel(phase) {
    return PHASE_LABELS[phase] || phase || "等待状态";
  }

  function jobKindLabel(kind) {
    return kind === "current" ? "当前播放触发" : "后台批处理";
  }

  function formatBytesSafe(value) {
    return Number(value || 0) > 0 ? formatBytes(value) : "尚未写入";
  }

  return Object.freeze({ mount, stopPolling });
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Number(value || 0)));
}

function formatDuration(value) {
  const milliseconds = Math.max(0, Number(value || 0));
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function formatClock(value) {
  const seconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatDateTime(value) {
  return new Date(Number(value || 0)).toLocaleString("zh-CN", { hour12: false });
}

function scaledDimensions(widthValue, heightValue, maxEdgeValue) {
  const width = Math.max(0, Number(widthValue || 0));
  const height = Math.max(0, Number(heightValue || 0));
  const maxEdge = Math.max(2, Number(maxEdgeValue || 2560));
  if (!width || !height) return { width: 0, height: 0 };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(2, Math.floor(width * scale / 2) * 2),
    height: Math.max(2, Math.floor(height * scale / 2) * 2)
  };
}

function resolutionLabel(widthValue, heightValue) {
  const width = Math.max(0, Number(widthValue || 0));
  const height = Math.max(0, Number(heightValue || 0));
  if (!width || !height) return "画质未知";
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  if (longEdge >= 3800 || shortEdge >= 2100) return "4K / 2160p";
  if (longEdge >= 2500 || shortEdge >= 1400) return "2K / 1440p";
  if (longEdge >= 1900 || shortEdge >= 1060) return "1080p";
  if (longEdge >= 1260 || shortEdge >= 700) return "720p";
  return "标清";
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(String(value || ""));
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = String(value || "");
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("复制失败");
}
