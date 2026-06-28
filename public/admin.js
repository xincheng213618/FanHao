const state = {
  library: null,
  health: null,
  config: { compilationPrefixes: [], compilationKeywords: [], actorAvatarDataPath: "", imageReaderCacheMaxBytes: 2 * 1024 * 1024 * 1024 },
  people: [],
  scripts: [],
  categories: [],
  tasks: [],
  readerCache: null,
  taskSummary: {},
  selectedScriptId: "",
  selectedCategory: "all",
  selectedRisk: "all",
  scriptQuery: "",
  globalQuery: "",
  selectedPersonId: "",
  selectedTaskId: "",
  taskFilter: "all",
  activeView: "overview",
  handledTasks: new Set(),
  pollTimer: null
};

const els = {
  serviceMode: document.querySelector("#adminServiceMode"),
  sideHealth: document.querySelector("#adminSideHealth"),
  sideTotals: document.querySelector("#adminSideTotals"),
  viewEyebrow: document.querySelector("#adminViewEyebrow"),
  viewTitle: document.querySelector("#adminViewTitle"),
  navButtons: [...document.querySelectorAll("[data-admin-nav]")],
  views: [...document.querySelectorAll("[data-admin-view]")],
  navScriptCount: document.querySelector("#adminNavScriptCount"),
  navTaskCount: document.querySelector("#adminNavTaskCount"),
  lastRefresh: document.querySelector("#adminLastRefresh"),
  quickSearch: document.querySelector("#adminQuickSearch"),
  refreshAll: document.querySelector("#adminRefreshAll"),
  scriptCount: document.querySelector("#adminScriptCount"),
  scriptCategorySummary: document.querySelector("#adminScriptCategorySummary"),
  runningCount: document.querySelector("#adminRunningCount"),
  doneCount: document.querySelector("#adminDoneCount"),
  errorCount: document.querySelector("#adminErrorCount"),
  errorSummary: document.querySelector("#adminErrorSummary"),
  healthBadge: document.querySelector("#adminHealthBadge"),
  healthMode: document.querySelector("#adminHealthMode"),
  healthRoots: document.querySelector("#adminHealthRoots"),
  healthWorks: document.querySelector("#adminHealthWorks"),
  healthScannedAt: document.querySelector("#adminHealthScannedAt"),
  healthStatus: document.querySelector("#adminHealthStatus"),
  taskRail: document.querySelector("#adminTaskRail"),
  failureRail: document.querySelector("#adminFailureRail"),
  taskList: document.querySelector("#adminTaskList"),
  taskDetail: document.querySelector("#adminTaskDetail"),
  taskFilters: [...document.querySelectorAll("[data-task-filter]")],
  refreshTasks: document.querySelector("#adminRefreshTasks"),
  scriptChips: document.querySelector("#adminScriptChips"),
  scriptCategory: document.querySelector("#adminScriptCategory"),
  scriptRisk: document.querySelector("#adminScriptRisk"),
  scriptSearch: document.querySelector("#adminScriptSearch"),
  refreshScripts: document.querySelector("#adminRefreshScripts"),
  scriptList: document.querySelector("#adminScriptList"),
  scriptForm: document.querySelector("#adminScriptForm"),
  selectedScriptCategory: document.querySelector("#adminSelectedScriptCategory"),
  selectedScriptTitle: document.querySelector("#adminSelectedScriptTitle"),
  selectedScriptRuntime: document.querySelector("#adminSelectedScriptRuntime"),
  selectedScriptRisk: document.querySelector("#adminSelectedScriptRisk"),
  selectedScriptDescription: document.querySelector("#adminSelectedScriptDescription"),
  selectedScriptMeta: document.querySelector("#adminSelectedScriptMeta"),
  scriptFields: document.querySelector("#adminScriptFields"),
  dangerBox: document.querySelector("#adminDangerBox"),
  dangerConfirm: document.querySelector("#adminDangerConfirm"),
  commandPreview: document.querySelector("#adminCommandPreview"),
  runScript: document.querySelector("#adminRunScript"),
  resetScriptFields: document.querySelector("#adminResetScriptFields"),
  scriptStatus: document.querySelector("#adminScriptStatus"),
  personSelect: document.querySelector("#adminPersonSelect"),
  rescanPerson: document.querySelector("#adminRescanPerson"),
  refreshActor: document.querySelector("#adminRefreshActor"),
  refreshRankings: document.querySelector("#adminRefreshRankings"),
  status: document.querySelector("#adminStatus"),
  actorAvatarPath: document.querySelector("#adminActorAvatarDataPath"),
  previewActorAvatars: document.querySelector("#adminPreviewActorAvatars"),
  importActorAvatars: document.querySelector("#adminImportActorAvatars"),
  actorAvatarCandidates: document.querySelector("#adminActorAvatarCandidates"),
  refreshCoverStatus: document.querySelector("#adminRefreshCoverStatus"),
  coverLimit: document.querySelector("#adminCoverLimit"),
  generateCovers: document.querySelector("#adminGenerateCovers"),
  coverStatus: document.querySelector("#adminCoverStatus"),
  refreshImageReaderCache: document.querySelector("#adminRefreshImageReaderCache"),
  imageReaderCacheRoot: document.querySelector("#adminImageReaderCacheRoot"),
  imageReaderCacheSize: document.querySelector("#adminImageReaderCacheSize"),
  imageReaderCacheFiles: document.querySelector("#adminImageReaderCacheFiles"),
  imageReaderCacheLimit: document.querySelector("#adminImageReaderCacheLimit"),
  imageReaderCacheLimitInput: document.querySelector("#adminImageReaderCacheLimitInput"),
  saveImageReaderCacheLimit: document.querySelector("#adminSaveImageReaderCacheLimit"),
  cleanupImageReaderCache: document.querySelector("#adminCleanupImageReaderCache"),
  imageReaderCacheStatus: document.querySelector("#adminImageReaderCacheStatus"),
  compilationPrefixes: document.querySelector("#adminCompilationPrefixes"),
  compilationKeywords: document.querySelector("#adminCompilationKeywords"),
  saveCompilationConfig: document.querySelector("#adminSaveCompilationConfig"),
  configStatus: document.querySelector("#adminConfigStatus")
};

const formatter = new Intl.NumberFormat("zh-CN");
const VIEW_TITLES = {
  overview: ["后台", "系统总览"],
  scripts: ["运维", "作业中心"],
  tasks: ["监控", "任务队列"],
  maintenance: ["资料库", "数据维护"],
  rules: ["配置", "规则配置"]
};

function formatNumber(value) {
  return formatter.format(Number(value || 0));
}

function formatCompact(value) {
  return Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(ms) {
  if (!Number.isFinite(Number(ms))) return "-";
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function taskStatusLabel(status) {
  return {
    running: "运行中",
    stopping: "停止中",
    stopped: "已停止",
    done: "完成",
    error: "异常"
  }[status] || status || "-";
}

function riskLabel(risk) {
  return {
    safe: "安全",
    normal: "常规",
    write: "写入",
    careful: "谨慎",
    danger: "高风险"
  }[risk] || "常规";
}

function riskyScript(script) {
  return ["danger", "careful"].includes(script?.risk);
}

function displayPersonName(person) {
  const names = [person.name, ...(person.actorProfile?.aliases || [])].filter(Boolean);
  return [...new Set(names)].join(", ") || person.id;
}

function defaultUiConfig() {
  return {
    compilationPrefixes: ["OFJE", "THN", "THU"],
    compilationKeywords: ["合集", "総集編", "総集", "コンプリート", "全タイトル", "ベスト盤"],
    actorAvatarDataPath: "",
    imageReaderCacheMaxBytes: 2 * 1024 * 1024 * 1024
  };
}

function normalizeUiConfig(config = {}) {
  const fallback = defaultUiConfig();
  return {
    compilationPrefixes: Array.isArray(config.compilationPrefixes) ? config.compilationPrefixes : fallback.compilationPrefixes,
    compilationKeywords: Array.isArray(config.compilationKeywords) ? config.compilationKeywords : fallback.compilationKeywords,
    actorAvatarDataPath: String(config.actorAvatarDataPath || ""),
    imageReaderCacheMaxBytes: normalizeCacheBytes(config.imageReaderCacheMaxBytes, fallback.imageReaderCacheMaxBytes)
  };
}

function normalizeCacheBytes(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return 0;
  return Math.max(128 * 1024 * 1024, Math.min(200 * 1024 * 1024 * 1024, Math.floor(parsed)));
}

function linesFromTextarea(value) {
  return [...new Set(String(value || "").split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean))];
}

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && payload.loginUrl) window.location.assign(payload.loginUrl);
    throw new Error(payload.error || `请求失败：${response.status}`);
  }
  return payload;
}

function setBusy(button, busy, text = "处理中") {
  if (!button) return;
  const original = button.dataset.originalText || button.textContent;
  button.dataset.originalText = original;
  button.disabled = busy;
  button.textContent = busy ? text : original;
}

function setText(node, value) {
  if (node) node.textContent = value;
}

async function loadLibrary() {
  const data = await api("/api/library");
  state.library = data;
  state.people = data.people || [];
  state.config = normalizeUiConfig(data.uiConfig);
  if (!state.selectedPersonId || !state.people.some((person) => person.id === state.selectedPersonId)) {
    state.selectedPersonId = state.people[0]?.id || "";
  }
  renderPeopleSelect();
  renderConfigFields();
  renderSystemSummary();
  renderScriptPanel();
}

async function loadHealth() {
  state.health = await api("/api/health");
  renderHealth();
}

async function loadScripts() {
  const data = await api("/api/admin/scripts");
  state.scripts = data.scripts || [];
  state.categories = data.categories || [];
  if (!state.selectedScriptId || !state.scripts.some((script) => script.id === state.selectedScriptId)) {
    state.selectedScriptId = state.scripts[0]?.id || "";
  }
  renderScriptCategories();
  renderScripts();
  renderScriptPanel();
  renderOverviewCounts();
}

async function refreshTasks() {
  const data = await api("/api/admin/tasks");
  const previous = new Map(state.tasks.map((task) => [task.id, task.status]));
  state.tasks = data.tasks || [];
  state.taskSummary = data.summary || {};
  if (!state.selectedTaskId || !state.tasks.some((task) => task.id === state.selectedTaskId)) {
    state.selectedTaskId = state.tasks[0]?.id || "";
  }
  renderTasks();
  renderScripts();
  renderOverviewCounts();
  renderLastRefresh();
  await handleCompletedTasks(previous);
}

async function refreshAll() {
  setBusy(els.refreshAll, true, "刷新中");
  try {
    await Promise.all([loadHealth(), loadLibrary(), loadScripts(), refreshTasks(), loadImageReaderCache({ quiet: true })]);
    await refreshCoverCacheStatus({ quiet: true });
    renderLastRefresh();
  } finally {
    setBusy(els.refreshAll, false);
  }
}

function renderLastRefresh() {
  setText(els.lastRefresh, `更新 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
}

function renderSystemSummary() {
  const totals = state.library?.totals || {};
  const roots = state.library?.availableRoots?.length || 0;
  setText(els.sideTotals, `${formatNumber(roots)} 盘 · ${formatCompact(totals.works)} 作品`);
}

function renderHealth() {
  const health = state.health;
  const accessMode = health?.access?.mode === "lan" ? "局域网" : "本机";
  const missingRoots = Number(health?.missingRootCount || 0);
  const ok = Boolean(health?.ok) && !health?.lastScanError && !missingRoots;
  setText(els.serviceMode, `${accessMode}控制台`);
  setText(els.sideHealth, ok ? "服务正常" : "需要处理");
  setText(els.healthBadge, ok ? "正常" : "异常");
  els.healthBadge?.classList.toggle("error", !ok);
  setText(els.healthMode, accessMode);
  setText(els.healthRoots, `${formatNumber(health?.availableRootCount || 0)}/${formatNumber((health?.availableRootCount || 0) + missingRoots)}`);
  setText(els.healthWorks, formatNumber(health?.totals?.works || 0));
  setText(els.healthScannedAt, formatDateTime(health?.scannedAt));
  setText(els.healthStatus, health?.lastScanError || (missingRoots ? `缺少 ${formatNumber(missingRoots)} 个来源盘` : "服务可用"));
}

function renderOverviewCounts() {
  const running = state.tasks.filter((task) => task.status === "running" || task.status === "stopping").length;
  const done = state.tasks.filter((task) => task.status === "done").length;
  const errors = state.tasks.filter((task) => task.status === "error").length;
  setText(els.scriptCount, formatNumber(state.scripts.length));
  setText(els.navScriptCount, formatNumber(state.scripts.length));
  setText(els.navTaskCount, formatNumber(state.tasks.length));
  setText(els.runningCount, formatNumber(running));
  setText(els.doneCount, formatNumber(done));
  setText(els.errorCount, formatNumber(errors));
  setText(els.scriptCategorySummary, `${formatNumber(state.categories.length)} 个分类`);
  setText(els.errorSummary, errors ? "需要查看日志" : "运行正常");
  renderScriptChips();
}

function renderScriptChips() {
  if (!els.scriptChips) return;
  els.scriptChips.innerHTML = "";
  const riskCounts = state.scripts.reduce((acc, script) => {
    const risk = script.risk || "normal";
    acc[risk] = (acc[risk] || 0) + 1;
    return acc;
  }, {});
  const chips = [
    ["all", "全部", state.scripts.length],
    ["safe", "安全", riskCounts.safe || 0],
    ["write", "写入", riskCounts.write || 0],
    ["careful", "谨慎", riskCounts.careful || 0],
    ["danger", "高风险", riskCounts.danger || 0]
  ];
  for (const [risk, label, count] of chips) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `admin-chip ${state.selectedRisk === risk ? "active" : ""}`;
    button.textContent = `${label} ${formatNumber(count)}`;
    button.addEventListener("click", () => {
      state.selectedRisk = risk;
      if (els.scriptRisk) els.scriptRisk.value = risk;
      setView("scripts", { pushHash: true });
      renderScripts();
      renderScriptChips();
    });
    els.scriptChips.append(button);
  }
}

function renderPeopleSelect() {
  if (!els.personSelect) return;
  els.personSelect.innerHTML = "";
  for (const person of state.people) {
    const option = document.createElement("option");
    option.value = person.id;
    option.textContent = `${displayPersonName(person)} · ${formatNumber(person.workCount)} 部`;
    els.personSelect.append(option);
  }
  els.personSelect.value = state.selectedPersonId;
}

function renderConfigFields() {
  const config = normalizeUiConfig(state.config);
  if (els.actorAvatarPath) els.actorAvatarPath.value = config.actorAvatarDataPath || "";
  if (els.compilationPrefixes) els.compilationPrefixes.value = config.compilationPrefixes.join("\n");
  if (els.compilationKeywords) els.compilationKeywords.value = config.compilationKeywords.join("\n");
  if (els.imageReaderCacheLimitInput) {
    const bytes = state.readerCache?.maxBytes ?? config.imageReaderCacheMaxBytes;
    els.imageReaderCacheLimitInput.value = String((bytes / 1024 / 1024 / 1024).toFixed(2));
  }
}

function renderScriptCategories() {
  if (!els.scriptCategory) return;
  els.scriptCategory.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "全部";
  els.scriptCategory.append(all);
  for (const category of state.categories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    els.scriptCategory.append(option);
  }
  els.scriptCategory.value = state.selectedCategory;
  if (els.scriptRisk) els.scriptRisk.value = state.selectedRisk;
}

function filteredScripts() {
  const query = [state.scriptQuery, state.globalQuery].filter(Boolean).join(" ").trim().toLowerCase();
  return state.scripts.filter((script) => {
    if (state.selectedCategory !== "all" && script.category !== state.selectedCategory) return false;
    if (state.selectedRisk !== "all" && script.risk !== state.selectedRisk) return false;
    if (!query) return true;
    return `${script.title} ${script.category} ${script.description} ${script.riskLabel || ""}`.toLowerCase().includes(query);
  });
}

function currentScript() {
  return state.scripts.find((script) => script.id === state.selectedScriptId) || state.scripts[0] || null;
}

function runningTasksForScript(scriptId) {
  return state.tasks.filter((task) => task.scriptId === scriptId && (task.status === "running" || task.status === "stopping"));
}

function renderScripts() {
  if (!els.scriptList) return;
  els.scriptList.innerHTML = "";
  const scripts = filteredScripts();
  if (!scripts.length) {
    els.scriptList.append(emptyNode("没有匹配脚本"));
    return;
  }
  for (const script of scripts) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "admin-script-card";
    card.classList.toggle("active", script.id === state.selectedScriptId);
    const running = runningTasksForScript(script.id).length;
    card.classList.toggle("running", Boolean(running));
    const head = document.createElement("span");
    head.className = "admin-script-card-head";
    const title = document.createElement("strong");
    title.textContent = script.title;
    const badge = document.createElement("em");
    badge.className = `admin-risk ${script.risk || "normal"}`;
    badge.textContent = script.riskLabel || riskLabel(script.risk);
    head.append(title, badge);
    const meta = document.createElement("span");
    meta.textContent = `${script.category} · ${script.runtime}${running ? ` · 运行中 ${formatNumber(running)}` : ""}`;
    const desc = document.createElement("small");
    desc.textContent = script.description || "";
    card.append(head, meta, desc);
    card.addEventListener("click", () => {
      state.selectedScriptId = script.id;
      renderScripts();
      renderScriptPanel();
    });
    els.scriptList.append(card);
  }
}

function renderScriptPanel() {
  const script = currentScript();
  if (!script || !els.scriptFields) return;
  setText(els.selectedScriptCategory, script.category || "脚本");
  setText(els.selectedScriptTitle, script.title || "选择一个脚本");
  setText(els.selectedScriptRuntime, script.runtime || "-");
  setText(els.selectedScriptRisk, script.riskLabel || riskLabel(script.risk));
  if (els.selectedScriptRisk) {
    els.selectedScriptRisk.className = `admin-badge risk-${script.risk || "normal"}`;
  }
  setText(els.selectedScriptDescription, script.description || "-");
  renderSelectedScriptMeta(script);
  els.scriptFields.innerHTML = "";
  for (const field of script.fields || []) {
    els.scriptFields.append(createScriptField(field));
  }
  if (!(script.fields || []).length) els.scriptFields.append(emptyNode("无需参数"));
  if (els.dangerBox) els.dangerBox.hidden = !riskyScript(script);
  if (els.dangerConfirm) els.dangerConfirm.checked = false;
  if (els.runScript) els.runScript.disabled = false;
  renderCommandPreview();
}

function renderSelectedScriptMeta(script) {
  if (!els.selectedScriptMeta) return;
  els.selectedScriptMeta.innerHTML = "";
  const items = [
    ["脚本", script.script || "-"],
    ["刷新", (script.refreshHints || []).join(", ") || "-"],
    ["影响", (script.invalidates || []).join(", ") || "-"]
  ];
  for (const [label, value] of items) {
    const item = document.createElement("div");
    const key = document.createElement("span");
    key.textContent = label;
    const text = document.createElement("strong");
    text.textContent = value;
    item.append(key, text);
    els.selectedScriptMeta.append(item);
  }
}

function createScriptField(field) {
  const label = document.createElement("label");
  label.className = `admin-field admin-script-field ${field.type === "checkbox" ? "checkbox" : ""}`;
  label.dataset.fieldName = field.name;
  if (field.type === "checkbox") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = field.name;
    input.checked = Boolean(field.default);
    const text = document.createElement("span");
    text.textContent = field.label;
    label.append(input, text);
    return label;
  }

  const title = document.createElement("span");
  title.textContent = field.required ? `${field.label} *` : field.label;
  label.append(title);
  let control;
  if (field.type === "select") {
    control = document.createElement("select");
    for (const option of field.options || []) {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label || option.value;
      control.append(item);
    }
    control.value = field.default || control.options[0]?.value || "";
  } else if (field.type === "textarea-list") {
    control = document.createElement("textarea");
    control.rows = 4;
    control.value = Array.isArray(field.default) ? field.default.join("\n") : field.default || "";
    control.placeholder = field.placeholder || "";
  } else if (field.type === "person") {
    control = document.createElement("select");
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = field.placeholder || "不限定人物";
    control.append(empty);
    for (const person of state.people) {
      const option = document.createElement("option");
      option.value = person.id;
      option.textContent = `${displayPersonName(person)} · ${formatNumber(person.workCount)} 部`;
      control.append(option);
    }
    control.value = state.selectedPersonId || "";
  } else {
    control = document.createElement("input");
    control.type = field.type === "number" ? "number" : "text";
    control.value = field.default ?? "";
    control.placeholder = field.placeholder || "";
    if (field.min !== null && field.min !== undefined) control.min = field.min;
    if (field.max !== null && field.max !== undefined) control.max = field.max;
    if (field.step !== null && field.step !== undefined) control.step = field.step;
  }
  control.name = field.name;
  if (field.required) control.required = true;
  control.addEventListener("input", renderCommandPreview);
  control.addEventListener("change", renderCommandPreview);
  label.append(control);
  if (field.help) {
    const help = document.createElement("small");
    help.textContent = field.help;
    label.append(help);
  }
  return label;
}

function collectScriptOptions(script) {
  const options = {};
  for (const field of script.fields || []) {
    const wrapper = els.scriptFields?.querySelector(`[data-field-name="${CSS.escape(field.name)}"]`);
    const control = wrapper?.querySelector("input, select, textarea");
    if (!control) continue;
    options[field.name] = control.type === "checkbox" ? control.checked : control.value;
  }
  return options;
}

function normalizeListValue(value) {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function appendPreviewArg(args, field, value) {
  if (field.type === "checkbox") {
    if (value && field.flag) args.push(field.flag);
    return;
  }
  if (field.type === "textarea-list") {
    for (const item of normalizeListValue(value)) {
      if (field.flag) args.push(field.flag, item);
      else args.push(item);
    }
    return;
  }
  if (value === "" || value === null || value === undefined) return;
  if (field.positional) args.push(String(value));
  else if (field.flag) args.push(field.flag, String(value));
}

function quoteCommandPart(value) {
  const text = String(value || "");
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function renderCommandPreview() {
  if (!els.commandPreview) return;
  const script = currentScript();
  if (!script) {
    setText(els.commandPreview, "-");
    return;
  }
  const options = collectScriptOptions(script);
  const args = [];
  if (script.runtime === "python") args.push("-u", script.script);
  else args.push(script.script);
  for (const field of script.fields || []) {
    appendPreviewArg(args, field, options[field.name]);
  }
  const command = script.runtime === "python" ? "python" : "node";
  setText(els.commandPreview, [command, ...args].map(quoteCommandPart).join(" "));
}

async function runSelectedScript(event) {
  event.preventDefault();
  const script = currentScript();
  if (!script) return;
  if (riskyScript(script) && !els.dangerConfirm?.checked) {
    setText(els.scriptStatus, "需要先确认高风险作业");
    return;
  }
  setBusy(els.runScript, true, "启动中");
  setText(els.scriptStatus, "正在启动脚本");
  try {
    const data = await api("/api/admin/scripts/run", {
      method: "POST",
      body: { scriptId: script.id, options: collectScriptOptions(script) }
    });
    setText(els.scriptStatus, `已启动：${data.task?.label || script.title}`);
    await refreshTasks();
    setView("tasks", { pushHash: true });
  } catch (error) {
    setText(els.scriptStatus, error.message || "启动脚本失败");
  } finally {
    setBusy(els.runScript, false);
  }
}

function renderTasks() {
  const failures = state.tasks.filter((task) => task.status === "error").slice(0, 4);
  renderTaskList(els.taskRail, state.tasks.slice(0, 4), { compact: true });
  renderTaskList(els.failureRail, failures, { compact: true });
  renderTaskList(els.taskList, filteredTasks(), { compact: false });
  renderTaskDetail();
  for (const button of els.taskFilters || []) {
    button.classList.toggle("active", button.dataset.taskFilter === state.taskFilter);
  }
}

function filteredTasks() {
  const query = state.globalQuery.trim().toLowerCase();
  return state.tasks.filter((task) => {
    if (state.taskFilter !== "all") {
      if (state.taskFilter === "running") {
        if (task.status !== "running" && task.status !== "stopping") return false;
      } else if (task.status !== state.taskFilter) {
        return false;
      }
    }
    if (!query) return true;
    return `${task.label} ${task.scriptId} ${task.type} ${task.personName} ${(task.logs || []).slice(-20).join(" ")}`.toLowerCase().includes(query);
  });
}

function renderTaskList(container, tasks, options = {}) {
  if (!container) return;
  container.innerHTML = "";
  if (!tasks.length) {
    container.append(emptyNode(options.compact ? "暂无记录" : "没有匹配任务"));
    return;
  }
  for (const task of tasks) {
    container.append(createTaskCard(task, options));
  }
}

function createTaskCard(task, options = {}) {
  const item = document.createElement("article");
  item.className = `admin-task ${task.status}`;
  item.classList.toggle("active", task.id === state.selectedTaskId && !options.compact);
  const head = document.createElement("div");
  head.className = "admin-task-head";
  const title = document.createElement("div");
  title.className = "admin-task-title";
  title.textContent = `${task.label} · ${task.personName || "全局"}`;
  const status = document.createElement("span");
  status.className = `admin-task-status ${task.status}`;
  status.textContent = taskStatusLabel(task.status);
  head.append(title, status);
  if (!options.compact) {
    item.tabIndex = 0;
    item.addEventListener("click", () => {
      state.selectedTaskId = task.id;
      renderTasks();
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        state.selectedTaskId = task.id;
        renderTasks();
      }
    });
  }
  if (task.canStop && !options.compact) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "folder-button compact";
    stop.textContent = "停止";
    stop.addEventListener("click", () => stopTask(task.id, stop));
    head.append(stop);
  }
  const meta = document.createElement("div");
  meta.className = "admin-task-meta";
  meta.textContent = [
    task.scriptId || task.type,
    task.pid ? `PID ${task.pid}` : "",
    task.startedAt ? `开始 ${formatDateTime(task.startedAt)}` : "",
    task.finishedAt ? `结束 ${formatDateTime(task.finishedAt)}` : "",
    task.durationMs ? `耗时 ${formatDuration(task.durationMs)}` : "",
    task.exitCode !== null && task.exitCode !== undefined ? `退出码 ${task.exitCode}` : ""
  ].filter(Boolean).join(" · ");
  const log = document.createElement("pre");
  log.textContent = (task.logs || []).slice(options.compact ? -5 : -30).join("\n");
  item.append(head, meta, log);
  return item;
}

function renderTaskDetail() {
  if (!els.taskDetail) return;
  const tasks = filteredTasks();
  const task = tasks.find((item) => item.id === state.selectedTaskId) || tasks[0] || null;
  if (!task) {
    els.taskDetail.innerHTML = "";
    els.taskDetail.append(emptyNode("暂无任务详情"));
    return;
  }
  state.selectedTaskId = task.id;
  els.taskDetail.innerHTML = "";
  const head = document.createElement("div");
  head.className = "admin-task-detail-head";
  const title = document.createElement("h3");
  title.textContent = task.label || "任务";
  const status = document.createElement("span");
  status.className = `admin-task-status ${task.status}`;
  status.textContent = taskStatusLabel(task.status);
  head.append(title, status);
  if (task.canStop) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "folder-button compact";
    stop.textContent = "停止";
    stop.addEventListener("click", () => stopTask(task.id, stop));
    head.append(stop);
  }
  const meta = document.createElement("dl");
  meta.className = "admin-task-detail-meta";
  for (const [label, value] of [
    ["任务 ID", task.id],
    ["脚本", task.scriptId || task.type || "-"],
    ["人物", task.personName || "全局"],
    ["PID", task.pid || "-"],
    ["开始", formatDateTime(task.startedAt)],
    ["结束", formatDateTime(task.finishedAt)],
    ["耗时", formatDuration(task.durationMs)],
    ["退出码", task.exitCode ?? "-"]
  ]) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    meta.append(dt, dd);
  }
  const log = document.createElement("pre");
  log.className = "admin-task-detail-log";
  log.textContent = (task.logs || []).join("\n") || "暂无日志";
  els.taskDetail.append(head, meta, log);
}

function emptyNode(text) {
  const node = document.createElement("div");
  node.className = "admin-empty";
  node.textContent = text;
  return node;
}

async function stopTask(taskId, button) {
  setBusy(button, true, "停止中");
  try {
    await api("/api/admin/tasks/stop", { method: "POST", body: { taskId } });
    await refreshTasks();
  } finally {
    setBusy(button, false);
  }
}

async function handleCompletedTasks(previous) {
  const completed = state.tasks.filter((task) => {
    if (task.status === "running" || task.status === "stopping" || state.handledTasks.has(task.id)) return false;
    return previous.get(task.id) === "running" || previous.get(task.id) === "stopping";
  });
  if (!completed.length) return;
  completed.forEach((task) => state.handledTasks.add(task.id));
  if (completed.some((task) => task.status === "done" && (task.refreshHints || []).length)) {
    await Promise.allSettled([loadHealth(), loadLibrary(), refreshCoverCacheStatus({ quiet: true }), loadImageReaderCache({ quiet: true })]);
  }
}

async function adminRescanSelectedPerson() {
  const personId = els.personSelect?.value || state.selectedPersonId;
  if (!personId) return;
  setBusy(els.rescanPerson, true, "扫描中");
  setText(els.status, "正在重新扫描人物本地文件");
  try {
    await api("/api/admin/rescan-person", { method: "POST", body: { personId } });
    setText(els.status, "本地检测已刷新");
    await loadLibrary();
  } catch (error) {
    setText(els.status, error.message || "刷新失败");
  } finally {
    setBusy(els.rescanPerson, false);
  }
}

async function adminRefreshActorMovies() {
  const personId = els.personSelect?.value || state.selectedPersonId;
  if (!personId) return;
  setBusy(els.refreshActor, true, "启动中");
  setText(els.status, "正在启动缺失检测任务");
  try {
    const data = await api("/api/admin/refresh-actor-movies", { method: "POST", body: { personId, sleep: 2 } });
    setText(els.status, `已启动：${data.task?.label || "任务"}`);
    await refreshTasks();
    setView("tasks", { pushHash: true });
  } catch (error) {
    setText(els.status, error.message || "启动失败");
  } finally {
    setBusy(els.refreshActor, false);
  }
}

async function adminRefreshRankings() {
  setBusy(els.refreshRankings, true, "启动中");
  setText(els.status, "正在启动排行榜缓存任务");
  try {
    const data = await api("/api/admin/refresh-rankings", { method: "POST", body: { key: "y2025", sleep: 2 } });
    setText(els.status, `已启动：${data.task?.label || "任务"}`);
    await refreshTasks();
    setView("tasks", { pushHash: true });
  } catch (error) {
    setText(els.status, error.message || "启动失败");
  } finally {
    setBusy(els.refreshRankings, false);
  }
}

async function saveCompilationConfig() {
  const config = normalizeUiConfig({
    ...state.config,
    compilationPrefixes: linesFromTextarea(els.compilationPrefixes?.value),
    compilationKeywords: linesFromTextarea(els.compilationKeywords?.value)
  });
  setBusy(els.saveCompilationConfig, true, "保存中");
  setText(els.configStatus, "");
  try {
    const data = await api("/api/admin/config", { method: "PUT", body: { config } });
    state.config = normalizeUiConfig(data.config);
    renderConfigFields();
    setText(els.configStatus, "已保存");
  } catch (error) {
    setText(els.configStatus, error.message || "保存失败");
  } finally {
    setBusy(els.saveCompilationConfig, false);
  }
}

function renderImageReaderCache() {
  const cache = state.readerCache || {};
  setText(els.imageReaderCacheRoot, cache.root || "data\\image-reader-cache");
  setText(els.imageReaderCacheSize, formatBytes(cache.currentBytes || 0));
  setText(els.imageReaderCacheFiles, formatNumber(cache.fileCount || 0));
  setText(els.imageReaderCacheLimit, formatBytes(cache.maxBytes ?? state.config.imageReaderCacheMaxBytes));
  renderConfigFields();
}

async function loadImageReaderCache(options = {}) {
  if (!options.quiet) setText(els.imageReaderCacheStatus, "正在读取图库阅读缓存");
  try {
    const data = await api("/api/image-reader/cache");
    state.readerCache = data.cache || null;
    state.config = normalizeUiConfig({ ...state.config, ...(data.config || {}), ...(data.cache ? { imageReaderCacheMaxBytes: data.cache.maxBytes } : {}) });
    renderImageReaderCache();
    if (!options.quiet) setText(els.imageReaderCacheStatus, "缓存状态已更新");
  } catch (error) {
    if (!options.quiet) setText(els.imageReaderCacheStatus, error.message || "缓存状态读取失败");
  }
}

async function saveImageReaderCacheLimit() {
  const gb = Math.max(0, Number(els.imageReaderCacheLimitInput?.value || 0) || 0);
  const bytes = gb * 1024 * 1024 * 1024;
  const config = normalizeUiConfig({ ...state.config, imageReaderCacheMaxBytes: bytes });
  setBusy(els.saveImageReaderCacheLimit, true, "保存中");
  setText(els.imageReaderCacheStatus, "");
  try {
    const data = await api("/api/admin/config", { method: "PUT", body: { config } });
    state.config = normalizeUiConfig(data.config);
    await loadImageReaderCache({ quiet: true });
    setText(els.imageReaderCacheStatus, "阅读缓存上限已保存");
  } catch (error) {
    setText(els.imageReaderCacheStatus, error.message || "保存失败");
  } finally {
    setBusy(els.saveImageReaderCacheLimit, false);
  }
}

async function cleanupImageReaderCache() {
  const confirmed = window.confirm("只会清空 data\\image-reader-cache 中的图库阅读缓存，不会删除 FanHao 番号缓存、封面数据库或原始压缩包。确定清空吗？");
  if (!confirmed) return;
  setBusy(els.cleanupImageReaderCache, true, "清理中");
  setText(els.imageReaderCacheStatus, "正在清理图库阅读缓存");
  try {
    const data = await api("/api/image-reader/cache/cleanup?force=1", { method: "POST" });
    state.readerCache = data.status || data.cache || state.readerCache;
    renderImageReaderCache();
    setText(els.imageReaderCacheStatus, "阅读缓存已清理");
  } catch (error) {
    setText(els.imageReaderCacheStatus, error.message || "清理失败");
  } finally {
    setBusy(els.cleanupImageReaderCache, false);
  }
}

async function refreshCoverCacheStatus(options = {}) {
  if (!options.quiet) setText(els.coverStatus, "正在统计缺封面");
  try {
    const data = await api("/api/admin/cover-cache-status?limit=0");
    const candidates = Number(data.candidates || 0);
    const ready = Number(data.ready || 0);
    const missingVideo = Number(data.missingVideo || 0);
    setText(
      els.coverStatus,
      candidates
        ? `缺封面候选 ${formatNumber(candidates)}，可生成 ${formatNumber(ready)}，视频不可读 ${formatNumber(missingVideo)}`
        : "当前没有需要补齐的封面"
    );
  } catch (error) {
    if (!options.quiet) setText(els.coverStatus, error.message || "封面状态读取失败");
  }
}

async function generateMissingCovers() {
  const limit = Math.max(1, Math.min(200, Number(els.coverLimit?.value || 20) || 20));
  if (els.coverLimit) els.coverLimit.value = String(limit);
  setBusy(els.generateCovers, true, "启动中");
  setText(els.coverStatus, "正在启动缺封面补齐任务");
  try {
    await api("/api/admin/generate-missing-covers", { method: "POST", body: { limit } });
    setText(els.coverStatus, "任务运行中");
    await refreshTasks();
    setView("tasks", { pushHash: true });
  } catch (error) {
    setText(els.coverStatus, error.message || "启动失败");
  } finally {
    setBusy(els.generateCovers, false);
  }
}

async function previewActorAvatars() {
  const rootPath = String(els.actorAvatarPath?.value || "").trim();
  setBusy(els.previewActorAvatars, true, "读取中");
  setText(els.status, "正在读取头像候选");
  if (els.actorAvatarCandidates) els.actorAvatarCandidates.innerHTML = "";
  try {
    const data = await api("/api/admin/actor-avatar-candidates", { method: "POST", body: { rootPath, limit: 60 } });
    state.config = normalizeUiConfig(data.config);
    renderConfigFields();
    renderActorAvatarCandidates(data.summary || {});
  } catch (error) {
    setText(els.status, error.message || "读取头像候选失败");
  } finally {
    setBusy(els.previewActorAvatars, false);
  }
}

async function importActorAvatars() {
  const rootPath = String(els.actorAvatarPath?.value || "").trim();
  setBusy(els.importActorAvatars, true, "扫描中");
  setText(els.status, "正在扫描本地演员头像");
  try {
    const data = await api("/api/admin/import-actor-avatars", { method: "POST", body: { rootPath, replace: false } });
    state.config = normalizeUiConfig(data.config);
    renderConfigFields();
    await loadLibrary();
    const summary = data.summary || {};
    setText(els.status, `头像扫描完成：导入 ${formatNumber(summary.imported || 0)}，匹配 ${formatNumber(summary.matched || 0)}`);
  } catch (error) {
    setText(els.status, error.message || "扫描演员头像失败");
  } finally {
    setBusy(els.importActorAvatars, false);
  }
}

function renderActorAvatarCandidates(summary = {}) {
  if (!els.actorAvatarCandidates) return;
  els.actorAvatarCandidates.innerHTML = "";
  const people = summary.people || [];
  setText(els.status, `头像候选：匹配 ${formatNumber(summary.matched || 0)} 个文件，涉及 ${formatNumber(summary.matchedPeople || 0)} 人`);
  if (!people.length) {
    els.actorAvatarCandidates.append(emptyNode("没有可选择的头像候选"));
    return;
  }
  for (const person of people) {
    const card = document.createElement("article");
    card.className = "admin-avatar-person";
    const header = document.createElement("div");
    header.className = "admin-avatar-person-header";
    const name = document.createElement("strong");
    name.textContent = person.displayName || person.personName || person.personId;
    const meta = document.createElement("span");
    meta.textContent = `${formatNumber((person.candidates || []).length)} 个候选${person.hasAvatar ? " · 已有头像" : ""}`;
    header.append(name, meta);
    card.append(header);
    for (const candidate of (person.candidates || []).slice(0, 4)) {
      card.append(createActorAvatarCandidateRow(person, candidate));
    }
    els.actorAvatarCandidates.append(card);
  }
}

function createActorAvatarCandidateRow(person, candidate) {
  const row = document.createElement("div");
  row.className = "admin-avatar-candidate";
  const text = document.createElement("div");
  text.className = "admin-avatar-candidate-text";
  const pathLine = document.createElement("span");
  pathLine.textContent = candidate.relPath || "";
  pathLine.title = candidate.relPath || "";
  const metaLine = document.createElement("small");
  metaLine.textContent = `${candidate.actorName || "未命名"} · ${formatNumber(candidate.size || 0)} B`;
  text.append(pathLine, metaLine);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "folder-button compact";
  button.textContent = "设为头像";
  button.addEventListener("click", () => applyActorAvatarCandidate(person.personId, candidate.relPath, button));
  row.append(text, button);
  return row;
}

async function applyActorAvatarCandidate(personId, relPath, button) {
  setBusy(button, true, "写入中");
  try {
    await api("/api/admin/apply-actor-avatar-candidate", {
      method: "POST",
      body: { rootPath: String(els.actorAvatarPath?.value || "").trim(), personId, relPath }
    });
    await loadLibrary();
    await previewActorAvatars();
  } catch (error) {
    setText(els.status, error.message || "设置头像失败");
  } finally {
    setBusy(button, false);
  }
}

function setView(view, options = {}) {
  state.activeView = VIEW_TITLES[view] ? view : "overview";
  const [eyebrow, title] = VIEW_TITLES[state.activeView];
  setText(els.viewEyebrow, eyebrow);
  setText(els.viewTitle, title);
  for (const button of els.navButtons) {
    button.classList.toggle("active", button.dataset.adminNav === state.activeView);
  }
  for (const panel of els.views) {
    panel.classList.toggle("active", panel.dataset.adminView === state.activeView);
  }
  if (options.pushHash) {
    history.replaceState(null, "", `#${state.activeView}`);
  }
}

function viewFromHash() {
  return window.location.hash.replace(/^#/, "") || "overview";
}

function bindEvents() {
  els.refreshAll?.addEventListener("click", refreshAll);
  els.refreshScripts?.addEventListener("click", loadScripts);
  els.refreshTasks?.addEventListener("click", refreshTasks);
  els.scriptForm?.addEventListener("submit", runSelectedScript);
  els.resetScriptFields?.addEventListener("click", () => {
    renderScriptPanel();
    setText(els.scriptStatus, "参数已重置");
  });
  els.quickSearch?.addEventListener("input", () => {
    state.globalQuery = els.quickSearch.value || "";
    renderScripts();
    renderTasks();
  });
  els.scriptCategory?.addEventListener("change", () => {
    state.selectedCategory = els.scriptCategory.value || "all";
    renderScripts();
  });
  els.scriptRisk?.addEventListener("change", () => {
    state.selectedRisk = els.scriptRisk.value || "all";
    renderScripts();
    renderScriptChips();
  });
  els.scriptSearch?.addEventListener("input", () => {
    state.scriptQuery = els.scriptSearch.value || "";
    renderScripts();
  });
  els.personSelect?.addEventListener("change", () => {
    state.selectedPersonId = els.personSelect.value || "";
    renderScriptPanel();
  });
  els.rescanPerson?.addEventListener("click", adminRescanSelectedPerson);
  els.refreshActor?.addEventListener("click", adminRefreshActorMovies);
  els.refreshRankings?.addEventListener("click", adminRefreshRankings);
  els.previewActorAvatars?.addEventListener("click", previewActorAvatars);
  els.importActorAvatars?.addEventListener("click", importActorAvatars);
  els.refreshCoverStatus?.addEventListener("click", refreshCoverCacheStatus);
  els.generateCovers?.addEventListener("click", generateMissingCovers);
  els.refreshImageReaderCache?.addEventListener("click", () => loadImageReaderCache());
  els.saveImageReaderCacheLimit?.addEventListener("click", saveImageReaderCacheLimit);
  els.cleanupImageReaderCache?.addEventListener("click", cleanupImageReaderCache);
  els.saveCompilationConfig?.addEventListener("click", saveCompilationConfig);
  for (const button of els.navButtons) {
    button.addEventListener("click", () => setView(button.dataset.adminNav, { pushHash: true }));
  }
  for (const button of els.taskFilters || []) {
    button.addEventListener("click", () => {
      state.taskFilter = button.dataset.taskFilter || "all";
      renderTasks();
    });
  }
  for (const button of document.querySelectorAll("[data-quick-script]")) {
    button.addEventListener("click", () => selectQuickScript(button.dataset.quickScript));
  }
  window.addEventListener("hashchange", () => setView(viewFromHash()));
}

function selectQuickScript(scriptId) {
  if (!scriptId) return;
  state.selectedScriptId = scriptId;
  state.selectedCategory = "all";
  state.selectedRisk = "all";
  if (els.scriptCategory) els.scriptCategory.value = "all";
  if (els.scriptRisk) els.scriptRisk.value = "all";
  setView("scripts", { pushHash: true });
  renderScripts();
  renderScriptPanel();
}

async function init() {
  bindEvents();
  setView(viewFromHash());
  await refreshAll();
  state.pollTimer = window.setInterval(refreshTasks, 2500);
}

init().catch((error) => {
  setText(els.sideHealth, error.message || "后台加载失败");
  setText(els.healthStatus, error.message || "后台加载失败");
});
