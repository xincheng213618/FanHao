const endpoint = "/api/photo-cover-warm";
const states = {
  idle: ["未开始", "开始预热", "start"],
  running: ["正在预热", "暂停", "pause"],
  pausing: ["正在暂停，等待手头的封面处理结束", "正在暂停…"],
  paused: ["已暂停", "继续", "resume"],
  complete: ["已完成", "重新预热", "start"]
};

export function createPhotoCoverWarmPanel({ api, formatNumber }) {
  const element = document.createElement("section");
  element.className = "maintenance-panel";
  element.setAttribute("aria-label", "图片封面预热");
  element.hidden = true;
  const heading = document.createElement("h2");
  heading.textContent = "图片封面预热";
  const message = document.createElement("span");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "maintenance-button";
  const header = document.createElement("div");
  header.className = "maintenance-panel-header";
  header.append(heading, message, button);
  const progress = document.createElement("progress");
  progress.setAttribute("aria-label", "已处理的封面");
  const summary = document.createElement("div");
  const error = document.createElement("div");
  error.setAttribute("role", "status");
  element.append(header, progress, summary, error);

  let timer, snapshot, action, requestError = "", revision = 0;
  let reading = false, changing = false, denied = false;

  function render() {
    const [label, buttonLabel, nextAction] = states[snapshot?.status] || ["进度暂不可用"];
    const group = snapshot?.collection;
    action = nextAction;
    message.textContent = group
      ? `${label} · 合集 ${group.index}/${snapshot.collectionCount} · ${group.title}（${formatNumber(group.done)}/${formatNumber(group.total)}）`
      : label;
    button.hidden = !buttonLabel;
    button.textContent = buttonLabel || "";
    button.disabled = changing || !action;
    progress.hidden = snapshot?.total === undefined;
    if (!progress.hidden) {
      progress.max = snapshot.total || 1;
      progress.value = snapshot.total ? snapshot.done : 1;
    }
    summary.textContent = snapshot?.counts
      ? `已处理 ${formatNumber(snapshot.done)} / ${formatNumber(snapshot.total)} · 剩余 ${formatNumber(snapshot.remaining)} · 新生成 ${formatNumber(snapshot.counts.generated)} · 已有 ${formatNumber(snapshot.counts.cached)} · 跳过无图片 ${formatNumber(snapshot.counts.skipped)} · 未找到 ${formatNumber(snapshot.counts.missing)} · 失败 ${formatNumber(snapshot.counts.failed)}`
      : "仅处理图片封面。";
    error.textContent = requestError || snapshot?.error || "";
    error.hidden = !error.textContent;
    element.hidden = false;
  }

  function schedule() {
    window.clearTimeout(timer);
    if (!denied && element.isConnected === true) {
      const delay = ["running", "pausing"].includes(snapshot?.status) ? 1000 : 5000;
      timer = window.setTimeout(refresh, delay);
    }
  }

  async function refresh() {
    if (denied || reading || changing || element.isConnected !== true) return;
    window.clearTimeout(timer);
    reading = true;
    const owner = revision;
    try {
      const current = await api(endpoint, { cache: "no-store" });
      if (owner !== revision) return;
      snapshot = current;
      requestError = "";
    } catch (failure) {
      if (owner !== revision) return;
      denied = failure.status === 403 || failure.status === 404;
      requestError = denied ? failure.message : "读取预热进度失败，正在重试。";
    } finally {
      reading = false;
      if (owner === revision) render();
      schedule();
    }
  }

  button.addEventListener("click", async () => {
    if (!action || changing) return;
    changing = true;
    revision++;
    window.clearTimeout(timer);
    render();
    try {
      snapshot = await api(`${endpoint}/${action}`, { method: "POST" });
      requestError = "";
    } catch (failure) {
      requestError = failure.message || "预热操作失败。";
    } finally {
      changing = false;
      render();
      schedule();
    }
  });

  return { element, refresh };
}
