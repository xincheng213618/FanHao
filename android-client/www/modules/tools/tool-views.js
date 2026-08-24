export function createToolViews(context) {
  const {
    els,
    setActiveBottom
  } = context;
  let explorationStatus = null;
  let explorationSessions = null;

  function renderTools() {
    setActiveBottom("tools");
    els.viewKicker.textContent = "个人中心";
    els.viewTitle.textContent = "我的";
    els.viewMeta.textContent = "";
    els.viewContent.replaceChildren(createVisionExplorationSection(), createGamesSection());
    void refreshExplorationSessions();
  }

  function createVisionExplorationSection() {
    const section = document.createElement("section");
    section.className = "tools-dashboard vision-exploration-dashboard";
    const head = document.createElement("div");
    head.className = "tools-section-head";
    const title = document.createElement("strong");
    title.textContent = "视觉技术探索";
    const meta = document.createElement("span");
    meta.textContent = "仅 Android · 本机演示";
    head.append(title, meta);

    const notice = document.createElement("p");
    notice.className = "vision-exploration-notice";
    notice.textContent = "体验自动证卡取景、人脸定位和随机动作验证。识别稳定后会自动拍摄确认；照片只存入 App 私有目录且不进入系统云备份，但不代表真实认证结果。";

    const launcher = document.createElement("section");
    launcher.className = "tool-launch-grid";
    launcher.append(
      createLaunchCard({
        badge: "CARD",
        title: "证卡扫描",
        detail: "身份证人像面→国徽面、银行卡自动扫描",
        actionLabel: "选择证卡",
        onOpen: () => runExploration("startDocumentScan")
      }),
      createLaunchCard({
        badge: "FACE",
        title: "人脸与真人验证",
        detail: "扫描光引导、随机转头或微笑、自动定格",
        actionLabel: "开始验证",
        onOpen: () => runExploration("startFaceVerification")
      })
    );

    explorationStatus = document.createElement("div");
    explorationStatus.className = "vision-exploration-status";
    explorationStatus.setAttribute("role", "status");
    explorationStatus.textContent = visionPlugin()
      ? "演示照片可在完成页或下方记录中复核，也可随时从本机删除。"
      : "此功能需要在 FanHao Android App 中打开。";

    const archiveHead = document.createElement("div");
    archiveHead.className = "vision-exploration-archive-head";
    const archiveTitle = document.createElement("strong");
    archiveTitle.textContent = "本地演示记录";
    const archiveMeta = document.createElement("span");
    archiveMeta.textContent = "App 私有目录";
    archiveHead.append(archiveTitle, archiveMeta);
    explorationSessions = document.createElement("div");
    explorationSessions.className = "vision-exploration-sessions";
    explorationSessions.textContent = "正在读取…";

    section.append(head, notice, launcher, explorationStatus, archiveHead, explorationSessions);
    return section;
  }

  function createGamesSection() {
    const section = document.createElement("section");
    section.className = "tools-dashboard";
    const head = document.createElement("div");
    head.className = "tools-section-head";
    const title = document.createElement("strong");
    title.textContent = "小游戏";
    const meta = document.createElement("span");
    meta.textContent = "离线可用";
    head.append(title, meta);
    section.append(head, createGameLauncher());
    return section;
  }

  function createGameLauncher() {
    const wrap = document.createElement("section");
    wrap.className = "tool-launch-grid";
    wrap.append(
      createLaunchCard({
        badge: "2048",
        title: "2048 AI",
        detail: "手玩、AI 建议或自动运行",
        url: "./games/2048/index.html"
      }),
      createLaunchCard({
        badge: "解",
        title: "华容道",
        detail: "经典滑块与 AI 自动解",
        url: "./games/huarongdao/index.html#/game"
      })
    );
    return wrap;
  }

  function createLaunchCard(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tool-launch-card";
    button.setAttribute("aria-label", `打开${item.title}`);
    button.addEventListener("click", () => {
      if (typeof item.onOpen === "function") item.onOpen();
      else window.location.assign(item.url);
    });

    const badge = document.createElement("span");
    badge.className = "tool-launch-badge";
    badge.textContent = item.badge;

    const body = document.createElement("span");
    body.className = "tool-launch-body";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const detail = document.createElement("small");
    detail.textContent = item.detail;
    body.append(title, detail);

    const action = document.createElement("span");
    action.className = "tool-launch-action";
    action.textContent = item.actionLabel || "打开";

    button.append(badge, body, action);
    return button;
  }

  function visionPlugin() {
    return window.Capacitor?.Plugins?.FanHaoVisionExploration || null;
  }

  async function runExploration(method) {
    const plugin = visionPlugin();
    if (!plugin || typeof plugin[method] !== "function") {
      updateExplorationStatus("当前环境没有原生视觉探索能力，请安装最新 Android 调试版。", "error");
      return;
    }
    updateExplorationStatus("原生探索界面已打开，完成或退出后会回到这里。", "busy");
    try {
      const result = await plugin[method]();
      if (result?.canceled) {
        updateExplorationStatus("本次探索已取消，未完成的照片已经删除。", "neutral");
      } else {
        const label = sessionKindLabel(result?.kind);
        updateExplorationStatus(`${label}探索已完成，保存 ${Number(result?.fileCount || 0)} 张演示照片。`, "success");
      }
      await refreshExplorationSessions();
    } catch (error) {
      updateExplorationStatus(error?.message || "无法完成视觉探索。", "error");
    }
  }

  function updateExplorationStatus(message, state = "neutral") {
    if (!explorationStatus?.isConnected) return;
    explorationStatus.textContent = message;
    explorationStatus.dataset.state = state;
  }

  async function refreshExplorationSessions() {
    const target = explorationSessions;
    const plugin = visionPlugin();
    if (!target?.isConnected) return;
    if (!plugin?.listSessions) {
      target.textContent = "仅 Android App 可读取本地记录。";
      return;
    }
    try {
      const result = await plugin.listSessions();
      if (target !== explorationSessions || !target.isConnected) return;
      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      target.replaceChildren();
      if (!sessions.length) {
        target.textContent = "还没有完成的演示记录。";
        return;
      }
      for (const session of sessions) target.append(createSessionRow(session));
    } catch (error) {
      if (target.isConnected) target.textContent = error?.message || "读取本地记录失败。";
    }
  }

  function createSessionRow(session) {
    const row = document.createElement("article");
    row.className = "vision-exploration-session";
    const badge = document.createElement("span");
    badge.className = "vision-exploration-session-badge";
    badge.textContent = sessionKindBadge(session?.kind);
    const body = document.createElement("span");
    body.className = "vision-exploration-session-body";
    const title = document.createElement("strong");
    title.textContent = sessionKindLabel(session?.kind);
    const detail = document.createElement("small");
    const completedAt = Number(session?.completedAt || session?.createdAt || 0);
    detail.textContent = `${formatSessionTime(completedAt)} · ${formatBytes(session?.bytes)}`;
    body.append(title, detail);

    const actions = document.createElement("span");
    actions.className = "vision-exploration-session-actions";
    const review = document.createElement("button");
    review.type = "button";
    review.className = "vision-exploration-review";
    review.textContent = "复核";
    review.addEventListener("click", async () => {
      const plugin = visionPlugin();
      if (!plugin?.openSession) {
        updateExplorationStatus("当前版本无法打开本地演示记录。", "error");
        return;
      }
      review.disabled = true;
      updateExplorationStatus("本地照片复核页面已打开。", "busy");
      try {
        const result = await plugin.openSession({ sessionId: String(session?.sessionId || "") });
        if (result?.deleted) updateExplorationStatus("本次本地演示记录及照片已删除。", "neutral");
        else updateExplorationStatus("已完成本地照片复核。", "neutral");
        await refreshExplorationSessions();
      } catch (error) {
        review.disabled = false;
        updateExplorationStatus(error?.message || "无法打开本地演示记录。", "error");
      }
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "vision-exploration-delete";
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`删除这条${sessionKindLabel(session?.kind)}演示记录？`)) return;
      remove.disabled = true;
      try {
        await visionPlugin()?.deleteSession?.({ sessionId: String(session?.sessionId || "") });
        await refreshExplorationSessions();
        updateExplorationStatus("本地演示记录已删除。", "neutral");
      } catch (error) {
        remove.disabled = false;
        updateExplorationStatus(error?.message || "删除失败。", "error");
      }
    });
    actions.append(review, remove);
    row.append(badge, body, actions);
    return row;
  }

  function sessionKindLabel(kind) {
    if (kind === "id-card") return "身份证扫描";
    if (kind === "bank-card") return "银行卡扫描";
    if (kind === "face-verification") return "人脸与真人验证";
    return "视觉探索";
  }

  function sessionKindBadge(kind) {
    if (kind === "id-card") return "ID";
    if (kind === "bank-card") return "CARD";
    if (kind === "face-verification") return "FACE";
    return "DEMO";
  }

  function formatSessionTime(timestamp) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(timestamp));
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return {
    renderTools
  };
}
