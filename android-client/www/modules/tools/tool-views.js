export function createToolViews(context) {
  const {
    els,
    setActiveBottom,
    openSettings = () => {}
  } = context;
  let explorationView = null;
  // The native activity owns one camera/session at a time, even across page renders.
  let explorationBusy = false;

  function renderTools() {
    setActiveBottom("tools");
    els.viewKicker.textContent = "个人中心";
    els.viewTitle.textContent = "我的";
    els.viewMeta.textContent = "";
    els.viewContent.className = "content-list tools-native-page";
    els.viewContent.replaceChildren(
      createProfileHeader(),
      createSettingsSection(),
      createVisionExplorationSection(),
      createGamesSection()
    );
    void refreshExplorationSessions();
  }

  function createProfileHeader() {
    const header = document.createElement("header");
    header.className = "tools-profile-header";
    const title = document.createElement("strong");
    title.textContent = "我的";
    const detail = document.createElement("span");
    detail.textContent = "设置、本机工具与离线功能";
    header.append(title, detail);
    return header;
  }

  function createSettingsSection() {
    const section = document.createElement("section");
    section.className = "tools-native-section tools-settings-section";
    const list = document.createElement("div");
    list.className = "tools-native-list";
    list.append(
      createNativeRow({
        icon: "account",
        title: "用户中心",
        detail: "登录注册、个人资料与邀请码管理",
        onOpen: () => openSettings({ section: "account" })
      }),
      createNativeRow({
        icon: "settings",
        title: "设置",
        detail: "服务地址、主题与应用更新",
        onOpen: () => openSettings()
      }),
      createNativeRow({
        icon: "storage",
        title: "存储与缓存",
        detail: "手机缓存、漫画原图与阅读缓存",
        onOpen: () => openSettings({ section: "storage" })
      })
    );
    section.append(list);
    return section;
  }

  function createVisionExplorationSection() {
    const section = document.createElement("section");
    section.className = "tools-native-section vision-exploration-dashboard";
    section.setAttribute("aria-busy", String(explorationBusy));
    const view = { section, controls: new Set(), readId: 0, status: null, sessions: null };
    explorationView = view;
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

    const launcher = document.createElement("div");
    launcher.className = "tools-native-list";
    launcher.append(
      createNativeRow({
        icon: "document",
        title: "证卡扫描",
        detail: "身份证人像面→国徽面、银行卡自动扫描",
        onOpen: () => runExploration(view, "startDocumentScan")
      }),
      createNativeRow({
        icon: "face",
        title: "人脸与真人验证",
        detail: "扫描光引导、随机转头或微笑、自动定格",
        onOpen: () => runExploration(view, "startFaceVerification")
      })
    );
    for (const button of launcher.children) registerExplorationControl(view, button);

    const explorationStatus = document.createElement("div");
    view.status = explorationStatus;
    explorationStatus.className = "vision-exploration-status";
    explorationStatus.setAttribute("role", "status");
    explorationStatus.textContent = visionPlugin()
      ? "已完成的照片可复核；保留的未完成记录可继续，或明确删除。"
      : "此功能需要在 FanHao Android App 中打开。";

    const archiveHead = document.createElement("div");
    archiveHead.className = "vision-exploration-archive-head";
    const archiveTitle = document.createElement("strong");
    archiveTitle.textContent = "本地演示记录";
    const archiveMeta = document.createElement("span");
    archiveMeta.className = "vision-exploration-archive-controls";
    const archiveLocation = document.createElement("span");
    archiveLocation.textContent = "App 私有目录";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "vision-exploration-refresh";
    refresh.textContent = "刷新";
    refresh.setAttribute("aria-label", "刷新本地演示记录");
    refresh.addEventListener("click", () => {
      if (!explorationBusy) void refreshExplorationSessions(view);
    });
    registerExplorationControl(view, refresh);
    archiveMeta.append(archiveLocation, refresh);
    archiveHead.append(archiveTitle, archiveMeta);
    const explorationSessions = document.createElement("div");
    view.sessions = explorationSessions;
    explorationSessions.className = "vision-exploration-sessions";
    explorationSessions.setAttribute("aria-live", "polite");
    explorationSessions.textContent = "正在读取…";

    section.append(head, notice, launcher, explorationStatus, archiveHead, explorationSessions);
    return section;
  }

  function createGamesSection() {
    const section = document.createElement("section");
    section.className = "tools-native-section";
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
    const wrap = document.createElement("div");
    wrap.className = "tools-native-list";
    wrap.append(
      createNativeRow({
        icon: "game",
        title: "2048 AI",
        detail: "手玩、AI 建议或自动运行",
        url: "./games/2048/index.html"
      }),
      createNativeRow({
        icon: "puzzle",
        title: "华容道",
        detail: "经典滑块与 AI 自动解",
        url: "./games/huarongdao/index.html#/game"
      })
    );
    return wrap;
  }

  function createNativeRow(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tool-native-row";
    button.setAttribute("aria-label", `打开${item.title}`);
    button.addEventListener("click", () => {
      if (typeof item.onOpen === "function") item.onOpen();
      else window.location.assign(item.url);
    });

    const icon = document.createElement("span");
    icon.className = `tool-native-icon is-${item.icon || "tool"}`;
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = nativeRowIcon(item.icon);

    const body = document.createElement("span");
    body.className = "tool-native-copy";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const detail = document.createElement("small");
    detail.textContent = item.detail;
    body.append(title, detail);

    const action = document.createElement("span");
    action.className = "tool-native-chevron";
    action.setAttribute("aria-hidden", "true");
    action.textContent = "›";

    button.append(icon, body, action);
    return button;
  }

  function nativeRowIcon(icon) {
    const icons = {
      account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>',
      settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.6-1.4.9-1.9-2.1-2.1-1.9.9-1.4-.6-.7-2h-3l-.7 2-1.4.6-1.9-.9-2.1 2.1.9 1.9-.6 1.4-2 .7v3l2 .7.6 1.4-.9 1.9 2.1 2.1 1.9-.9 1.4.6.7 2h3l.7-2 1.4-.6 1.9.9 2.1-2.1-.9-1.9.6-1.4z"/></svg>',
      storage: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6m-15 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/></svg>',
      document: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M13 10h4m-4 3h4m-9 3h9"/></svg>',
      face: '<svg viewBox="0 0 24 24"><path d="M8 4H5a1 1 0 0 0-1 1v3m12-4h3a1 1 0 0 1 1 1v3M8 20H5a1 1 0 0 1-1-1v-3m12 4h3a1 1 0 0 0 1-1v-3"/><circle cx="12" cy="11" r="4"/><path d="M10.5 10h.1m2.8 0h.1m-3.2 3c1 .8 2.4.8 3.4 0"/></svg>',
      game: '<svg viewBox="0 0 24 24"><path d="M7 8h10c2.2 0 4 1.8 4 4v3.5c0 2-2.3 3.2-3.9 2l-2.1-1.6H9l-2.1 1.6c-1.6 1.2-3.9 0-3.9-2V12c0-2.2 1.8-4 4-4z"/><path d="M8 11v4m-2-2h4m6-1h.1m2 2h.1"/></svg>',
      puzzle: '<svg viewBox="0 0 24 24"><path d="M4 4h6v3a2 2 0 1 0 4 0V4h6v6h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H4v-6h3a2 2 0 1 0 0-4H4z"/></svg>'
    };
    return icons[icon] || icons.settings;
  }

  function visionPlugin() {
    return window.Capacitor?.Plugins?.FanHaoVisionExploration || null;
  }

  function isExplorationViewActive(view) {
    return view === explorationView && Boolean(view?.section.isConnected);
  }

  function registerExplorationControl(view, button) {
    view.controls.add(button);
    button.disabled = explorationBusy;
    return button;
  }

  function setExplorationBusy(busy) {
    explorationBusy = busy;
    const view = explorationView;
    if (!view) return;
    view.section.setAttribute("aria-busy", String(busy));
    for (const button of view.controls) {
      if (!button.isConnected) view.controls.delete(button);
      else button.disabled = busy;
    }
  }

  async function performExplorationAction(view, action) {
    if (explorationBusy || !isExplorationViewActive(view)) return;
    setExplorationBusy(true);
    try {
      await action();
    } catch (error) {
      updateExplorationStatus(view, error?.message || "无法完成本地记录操作。", "error");
    } finally {
      // A previous page's result must never replace the newly rendered page.
      await refreshExplorationSessions(view);
      setExplorationBusy(false);
    }
  }

  async function runExploration(view, method, sessionId) {
    await performExplorationAction(view, async () => {
      const plugin = visionPlugin();
      if (typeof plugin?.[method] !== "function") {
        throw new Error("当前版本不支持此操作，请安装最新 Android 调试版。");
      }
      updateExplorationStatus(view, "正在打开原生探索界面，完成或退出后会回到这里。", "busy");
      const result = await plugin[method](sessionId ? { sessionId } : undefined);
      if (result?.canceled) {
        const message = result.preserved === true
          ? "本次探索未完成，记录已保留。可在下方继续，无法恢复的记录可明确删除。"
          : result.discarded === true
            ? "本次探索已退出，未完成的记录及照片已删除。"
            : "本次探索已退出。请查看下方本地记录确认保存状态。";
        updateExplorationStatus(view, message, "neutral");
      } else if (result?.canceled === false) {
        const label = sessionKindLabel(result?.kind);
        const count = Number(result?.fileCount);
        const saved = Number.isSafeInteger(count) && count > 0 ? `，保存 ${count} 张演示照片` : "";
        updateExplorationStatus(view, `${label}探索已完成${saved}。`, "success");
      } else {
        updateExplorationStatus(view, "已返回本地记录，请查看记录状态。", "neutral");
      }
    });
  }

  function updateExplorationStatus(view, message, state = "neutral") {
    if (!isExplorationViewActive(view)) return;
    view.status.textContent = message;
    view.status.dataset.state = state;
  }

  async function refreshExplorationSessions(view = explorationView) {
    if (!isExplorationViewActive(view)) return;
    const target = view.sessions;
    const readId = ++view.readId;
    const plugin = visionPlugin();
    if (typeof plugin?.listSessions !== "function") {
      target.classList.remove("has-items");
      target.textContent = "仅 Android App 可读取本地记录。";
      return;
    }
    target.setAttribute("aria-busy", "true");
    try {
      const result = await plugin.listSessions();
      if (!isExplorationViewActive(view) || readId !== view.readId) return;
      if (!Array.isArray(result?.sessions)) throw new Error("本地记录响应无效，请刷新重试。");
      const sessions = result.sessions;
      target.classList.toggle("has-items", sessions.length > 0);
      target.replaceChildren();
      if (!sessions.length) {
        target.textContent = "还没有本地演示记录。";
        return;
      }
      for (const session of sessions) target.append(createSessionRow(view, session));
      for (const button of view.controls) if (!button.isConnected) view.controls.delete(button);
    } catch (error) {
      if (isExplorationViewActive(view) && readId === view.readId) {
        target.classList.remove("has-items");
        target.textContent = `${error?.message || "读取本地记录失败。"} 可点击刷新重试。`;
      }
    } finally {
      if (isExplorationViewActive(view) && readId === view.readId) target.setAttribute("aria-busy", "false");
    }
  }

  function createSessionRow(view, session) {
    const row = document.createElement("article");
    row.className = "vision-exploration-session";
    const sessionId = typeof session?.sessionId === "string" ? session.sessionId.trim() : "";
    const knownKind = ["id-card", "bank-card", "face-verification"].includes(session?.kind);
    const canReview = Boolean(sessionId) && knownKind && session?.status === "complete"
      && (session?.canReview === undefined || session.canReview === true);
    const canResume = Boolean(sessionId) && knownKind && session?.status === "capturing" && session?.canResume === true;
    const state = canReview ? "complete" : canResume ? "capturing" : "unavailable";
    row.dataset.state = state;
    const badge = document.createElement("span");
    badge.className = "vision-exploration-session-badge";
    badge.textContent = sessionKindBadge(session?.kind);
    const body = document.createElement("span");
    body.className = "vision-exploration-session-body";
    const title = document.createElement("strong");
    title.textContent = sessionKindLabel(session?.kind);
    const stateLabel = document.createElement("span");
    stateLabel.className = "vision-exploration-session-state";
    stateLabel.textContent = canReview ? "已完成" : canResume ? "未完成 · 可继续" : "无法恢复";
    const detail = document.createElement("small");
    const completedAt = Number(session?.completedAt || session?.createdAt || 0);
    detail.textContent = `${formatSessionTime(completedAt)} · ${formatBytes(session?.bytes)}`;
    body.append(title, stateLabel, detail);
    if (!canReview) {
      const issue = document.createElement("small");
      issue.className = "vision-exploration-session-issue";
      issue.textContent = canResume
        ? resumeStepLabel(session?.nextStep)
        : String(session?.issue || "存档信息不完整，照片未自动删除。");
      body.append(issue);
    }

    const actions = document.createElement("span");
    actions.className = "vision-exploration-session-actions";
    if ((canReview || canResume) && sessionId) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "vision-exploration-review";
      open.textContent = canResume ? "继续" : "复核";
      open.setAttribute("aria-label", `${open.textContent}${sessionKindLabel(session?.kind)}记录`);
      registerExplorationControl(view, open);
      open.addEventListener("click", () => {
        if (canResume) return runExploration(view, "resumeSession", sessionId);
        return performExplorationAction(view, async () => {
          const plugin = visionPlugin();
          if (typeof plugin?.openSession !== "function") throw new Error("当前版本无法打开本地演示记录。");
          updateExplorationStatus(view, "正在打开本地照片复核页面。", "busy");
          const result = await plugin.openSession({ sessionId });
          updateExplorationStatus(view, result?.deleted === true
            ? "本次本地演示记录及照片已删除。" : "已返回本地记录。", "neutral");
        });
      });
      actions.append(open);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "vision-exploration-delete";
    remove.textContent = "删除";
    remove.setAttribute("aria-label", `删除${sessionKindLabel(session?.kind)}记录及照片`);
    if (sessionId) registerExplorationControl(view, remove);
    else remove.disabled = true;
    remove.addEventListener("click", () => {
      if (explorationBusy || !isExplorationViewActive(view) || !sessionId) return;
      const plugin = visionPlugin();
      if (typeof plugin?.deleteSession !== "function") {
        updateExplorationStatus(view, "当前版本无法删除本地演示记录。", "error");
        return;
      }
      if (!window.confirm(`删除这条${sessionKindLabel(session?.kind)}演示记录及其中全部照片？删除后无法恢复。`)) return;
      return performExplorationAction(view, async () => {
        updateExplorationStatus(view, "正在删除本地记录及照片…", "busy");
        const result = await plugin.deleteSession({ sessionId });
        if (result?.deleted !== true) throw new Error("未能确认删除成功，请刷新记录后重试。");
        updateExplorationStatus(view, "本地演示记录及照片已删除。", "neutral");
      });
    });
    actions.append(remove);
    row.append(badge, body, actions);
    return row;
  }

  function resumeStepLabel(step) {
    if (step === "ID_BACK") return "已保存人像面，继续拍摄国徽面。";
    if (step === "ID_FRONT") return "继续拍摄身份证人像面。";
    if (step === "BANK_FRONT") return "继续拍摄银行卡正面。";
    if (step === "FACE") return "继续后将重新进行人脸动作演示。";
    if (step === "COMPLETE") return "照片已保存，继续完成本地存档。";
    return "已保存的照片会保留，继续完成剩余步骤。";
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
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
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
