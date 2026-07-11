export function createAdminModal(deps) {
  const {
    api,
    displayPersonName,
    els,
    formatBytes,
    formatDateTime,
    formatNumber,
    loadFavorites,
    loadHistory,
    loadImageLibrary,
    loadLibrary,
    loadMusic,
    loadNovels,
    loadRankings,
    normalizeUiConfig,
    personWorkPageSize,
    renderMeta,
    renderPeopleIndex,
    renderPeopleIndexStats,
    renderPlayer,
    renderWorks,
    resetWorkPaging,
    selectPerson,
    state,
    updateWorkSnapshot
  } = deps;

let pendingAdminScriptDefaults = {};

function openAdminModal(options = {}) {
  if (state.accessMode !== "local") return;
  pendingAdminScriptDefaults = options.scriptDefaults || options.defaults || {};
  populateAdminPeople();
  els.adminStatus.textContent = "";
  els.adminBackdrop.hidden = false;
  els.adminModal.classList.add("open");
  els.adminModal.setAttribute("aria-hidden", "false");
  startAdminPolling();
  refreshCoverCacheStatus();
  const scriptsPromise = loadAdminScripts();
  if (options.scriptId) {
    scriptsPromise.then(() => {
      selectAdminScript(options.scriptId);
      applyAdminScriptDefaults();
    });
  }
  window.setTimeout(() => {
    if (options.scriptId) {
      els.adminScriptForm?.scrollIntoView({ block: "start" });
      els.adminRunScript?.focus();
      return;
    }
    els.adminPersonSelect?.focus();
  }, 0);
}

function closeAdminModal() {
  els.adminModal.classList.remove("open");
  els.adminModal.setAttribute("aria-hidden", "true");
  els.adminBackdrop.hidden = true;
  stopAdminPolling();
}

function populateAdminPeople() {
  if (!els.adminPersonSelect) return;
  const selected = state.selectedPersonId || els.adminPersonSelect.value;
  els.adminPersonSelect.innerHTML = "";
  for (const person of state.people) {
    const option = document.createElement("option");
    option.value = person.id;
    option.textContent = `${displayPersonName(person)} · ${formatNumber(person.workCount)} 部`;
    els.adminPersonSelect.append(option);
  }
  if (selected && state.people.some((person) => person.id === selected)) {
    els.adminPersonSelect.value = selected;
  }
}

function adminPersonId() {
  return els.adminPersonSelect?.value || state.selectedPersonId || "";
}

function setAdminBusy(button, busy, text = "处理中") {
  if (!button) return "";
  const original = button.dataset.originalText || button.textContent;
  button.dataset.originalText = original;
  button.disabled = busy;
  button.textContent = busy ? text : original;
  return original;
}

function currentAdminScript() {
  return state.adminScripts.find((script) => script.id === state.selectedAdminScriptId) || state.adminScripts[0] || null;
}

function selectAdminScript(scriptId) {
  if (!scriptId) return null;
  const script = state.adminScripts.find((item) => item.id === scriptId);
  if (!script) {
    state.selectedAdminScriptId = scriptId;
    return null;
  }
  state.selectedAdminScriptId = script.id;
  state.adminScriptCategory = script.category || "all";
  renderAdminScriptCategories();
  renderAdminScripts();
  renderAdminScriptPanel();
  if (els.adminScriptStatus) els.adminScriptStatus.textContent = `已选择：${script.title}`;
  return script;
}

function applyAdminScriptDefaults() {
  const defaults = pendingAdminScriptDefaults || {};
  pendingAdminScriptDefaults = {};
  if (!defaults || !Object.keys(defaults).length) return;
  for (const [name, value] of Object.entries(defaults)) {
    const wrapper = els.adminScriptFields?.querySelector(`[data-field-name="${CSS.escape(name)}"]`);
    const control = wrapper?.querySelector("input, select, textarea");
    if (!control) continue;
    if (control.type === "checkbox") control.checked = Boolean(value);
    else control.value = String(value ?? "");
  }
}

async function loadAdminScripts() {
  if (!els.adminScriptList) return;
  if (els.adminScriptStatus) els.adminScriptStatus.textContent = "正在读取脚本目录";
  try {
    const data = await api("/api/admin/scripts");
    state.adminScripts = data.scripts || [];
    state.adminScriptCategories = data.categories || [];
    if (!state.selectedAdminScriptId || !state.adminScripts.some((script) => script.id === state.selectedAdminScriptId)) {
      state.selectedAdminScriptId = state.adminScripts[0]?.id || "";
    }
    renderAdminScriptCategories();
    renderAdminScripts();
    renderAdminScriptPanel();
    updateAdminOverview();
    if (els.adminScriptStatus) els.adminScriptStatus.textContent = state.adminScripts.length ? "脚本目录已更新" : "没有可用脚本";
  } catch (error) {
    els.adminScriptList.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "admin-empty";
    empty.textContent = error.message || "脚本目录读取失败";
    els.adminScriptList.append(empty);
    if (els.adminScriptStatus) els.adminScriptStatus.textContent = error.message || "脚本目录读取失败";
  }
}

function renderAdminScriptCategories() {
  if (!els.adminScriptCategory) return;
  els.adminScriptCategory.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "全部";
  els.adminScriptCategory.append(allOption);
  for (const category of state.adminScriptCategories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    els.adminScriptCategory.append(option);
  }
  if (!state.adminScriptCategories.includes(state.adminScriptCategory)) state.adminScriptCategory = "all";
  els.adminScriptCategory.value = state.adminScriptCategory;
}

function visibleAdminScripts() {
  if (state.adminScriptCategory === "all") return state.adminScripts;
  return state.adminScripts.filter((script) => script.category === state.adminScriptCategory);
}

function adminScriptRunningTasks(scriptId) {
  return state.adminTasks.filter((task) => task.scriptId === scriptId && (task.status === "running" || task.status === "stopping"));
}

function renderAdminScripts() {
  if (!els.adminScriptList) return;
  els.adminScriptList.innerHTML = "";
  const scripts = visibleAdminScripts();
  if (!scripts.length) {
    const empty = document.createElement("div");
    empty.className = "admin-empty";
    empty.textContent = "这个分类下没有脚本";
    els.adminScriptList.append(empty);
    return;
  }
  for (const script of scripts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "admin-script-card";
    button.classList.toggle("active", script.id === state.selectedAdminScriptId);
    const running = adminScriptRunningTasks(script.id).length;
    if (running) button.classList.add("running");

    const title = document.createElement("strong");
    title.textContent = script.title;
    const meta = document.createElement("span");
    meta.textContent = `${script.category} · ${script.runtime}${running ? ` · 运行中 ${formatNumber(running)}` : ""}`;
    const desc = document.createElement("small");
    desc.textContent = script.description || "";
    button.append(title, meta, desc);
    button.addEventListener("click", () => {
      state.selectedAdminScriptId = script.id;
      renderAdminScripts();
      renderAdminScriptPanel();
    });
    els.adminScriptList.append(button);
  }
}

function renderAdminScriptPanel() {
  const script = currentAdminScript();
  if (!els.adminScriptFields) return;
  if (!script) {
    if (els.adminSelectedScriptTitle) els.adminSelectedScriptTitle.textContent = "选择一个脚本";
    if (els.adminSelectedScriptDescription) els.adminSelectedScriptDescription.textContent = "从左侧选择脚本后，可以调整参数并启动任务。";
    if (els.adminSelectedScriptCategory) els.adminSelectedScriptCategory.textContent = "脚本";
    if (els.adminSelectedScriptRuntime) els.adminSelectedScriptRuntime.textContent = "-";
    els.adminScriptFields.innerHTML = "";
    if (els.adminRunScript) els.adminRunScript.disabled = true;
    return;
  }

  if (els.adminSelectedScriptTitle) els.adminSelectedScriptTitle.textContent = script.title;
  if (els.adminSelectedScriptDescription) els.adminSelectedScriptDescription.textContent = script.description || "";
  if (els.adminSelectedScriptCategory) els.adminSelectedScriptCategory.textContent = script.category || "脚本";
  if (els.adminSelectedScriptRuntime) els.adminSelectedScriptRuntime.textContent = script.runtime || "-";
  if (els.adminRunScript) els.adminRunScript.disabled = false;

  els.adminScriptFields.innerHTML = "";
  for (const field of script.fields || []) {
    els.adminScriptFields.append(createAdminScriptField(script, field));
  }
  if (!(script.fields || []).length) {
    const empty = document.createElement("div");
    empty.className = "admin-empty compact";
    empty.textContent = "这个脚本不需要额外参数。";
    els.adminScriptFields.append(empty);
  }
}

function createAdminScriptField(script, field) {
  const label = document.createElement("label");
  label.className = `admin-field admin-script-field ${field.type === "checkbox" ? "checkbox" : ""}`;
  label.dataset.fieldName = field.name;
  label.dataset.fieldType = field.type;

  if (field.type === "checkbox") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(field.default);
    input.name = field.name;
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
    control.rows = 3;
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
    control.value = state.selectedPersonId || field.default || "";
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
  label.append(control);

  if (field.help) {
    const help = document.createElement("small");
    help.textContent = field.help;
    label.append(help);
  }

  return label;
}

function collectAdminScriptOptions(script) {
  const options = {};
  for (const field of script.fields || []) {
    const wrapper = els.adminScriptFields?.querySelector(`[data-field-name="${CSS.escape(field.name)}"]`);
    const control = wrapper?.querySelector("input, select, textarea");
    if (!control) continue;
    options[field.name] = control.type === "checkbox" ? control.checked : control.value;
  }
  return options;
}

async function runSelectedAdminScript(event) {
  event?.preventDefault();
  const script = currentAdminScript();
  if (!script) return;
  setAdminBusy(els.adminRunScript, true, "启动中");
  if (els.adminScriptStatus) els.adminScriptStatus.textContent = "正在启动脚本";
  try {
    const data = await api("/api/admin/scripts/run", {
      method: "POST",
      body: {
        scriptId: script.id,
        options: collectAdminScriptOptions(script)
      }
    });
    if (els.adminScriptStatus) els.adminScriptStatus.textContent = `已启动：${data.task?.label || script.title}`;
    await refreshAdminTasks();
    startAdminPolling();
  } catch (error) {
    if (els.adminScriptStatus) els.adminScriptStatus.textContent = error.message || "启动脚本失败";
  } finally {
    setAdminBusy(els.adminRunScript, false);
  }
}

async function stopAdminTask(taskId, button) {
  if (!taskId) return;
  setAdminBusy(button, true, "停止中");
  try {
    await api("/api/admin/tasks/stop", {
      method: "POST",
      body: { taskId }
    });
    if (els.adminScriptStatus) els.adminScriptStatus.textContent = "已发送停止请求";
    await refreshAdminTasks();
  } catch (error) {
    if (els.adminScriptStatus) els.adminScriptStatus.textContent = error.message || "停止任务失败";
  } finally {
    setAdminBusy(button, false);
  }
}

function updateAdminOverview() {
  if (els.adminScriptCount) els.adminScriptCount.textContent = formatNumber(state.adminScripts.length);
  const running = state.adminTasks.filter((task) => task.status === "running" || task.status === "stopping").length;
  const done = state.adminTasks.filter((task) => task.status === "done").length;
  const errors = state.adminTasks.filter((task) => task.status === "error").length;
  if (els.adminRunningCount) els.adminRunningCount.textContent = formatNumber(running);
  if (els.adminDoneCount) els.adminDoneCount.textContent = formatNumber(done);
  if (els.adminErrorCount) els.adminErrorCount.textContent = formatNumber(errors);
}

async function adminRescanSelectedPerson() {
  const personId = adminPersonId();
  if (!personId) return;
  setAdminBusy(els.adminRescanPerson, true, "扫描中");
  els.adminStatus.textContent = "正在重新扫描这个人物的本地文件";
  try {
    await api(`/api/admin/rescan-person?limit=${personWorkPageSize()}&sort=${encodeURIComponent(state.sortMode || "title")}`, {
      method: "POST",
      body: { personId }
    });
    await loadLibrary();
    els.adminStatus.textContent = "本地检测已刷新";
    if (state.selectedPersonId === personId) {
      await selectPerson(personId, { resetFilter: false });
    }
    populateAdminPeople();
  } catch (error) {
    els.adminStatus.textContent = error.message || "刷新失败";
  } finally {
    setAdminBusy(els.adminRescanPerson, false);
  }
}

async function adminRefreshActorMovies() {
  const personId = adminPersonId();
  if (!personId) return;
  setAdminBusy(els.adminRefreshActor, true, "启动中");
  els.adminStatus.textContent = "正在启动缺失检测任务";
  try {
    const data = await api("/api/admin/refresh-actor-movies", {
      method: "POST",
      body: { personId, sleep: 2 }
    });
    els.adminStatus.textContent = `已启动：${data.task?.label || "任务"}`;
    await refreshAdminTasks();
    startAdminPolling();
  } catch (error) {
    els.adminStatus.textContent = error.message || "启动失败";
  } finally {
    setAdminBusy(els.adminRefreshActor, false);
  }
}

async function adminRefreshRankings() {
  setAdminBusy(els.adminRefreshRankings, true, "启动中");
  els.adminStatus.textContent = "正在启动排行榜缓存任务";
  try {
    const data = await api("/api/admin/refresh-rankings", {
      method: "POST",
      body: { key: state.selectedRankingKey || "y2025", sleep: 2 }
    });
    els.adminStatus.textContent = `已启动：${data.task?.label || "任务"}`;
    await refreshAdminTasks();
    startAdminPolling();
  } catch (error) {
    els.adminStatus.textContent = error.message || "启动失败";
  } finally {
    setAdminBusy(els.adminRefreshRankings, false);
  }
}

async function adminImportActorAvatars() {
  setAdminBusy(els.adminImportActorAvatars, true, "扫描中");
  els.adminStatus.textContent = "正在扫描本地演员头像";
  try {
    const data = await api("/api/admin/import-actor-avatars", {
      method: "POST",
      body: { replace: false }
    });
    await loadLibrary();
    const summary = data.summary || {};
    const imported = formatNumber(summary.imported || 0);
    const matched = formatNumber(summary.matched || 0);
    const skipped = formatNumber(summary.skippedExisting || 0);
    els.adminStatus.textContent = `头像扫描完成：导入 ${imported}，匹配 ${matched}，已有头像跳过 ${skipped}`;
  } catch (error) {
    els.adminStatus.textContent = error.message || "扫描演员头像失败";
  } finally {
    setAdminBusy(els.adminImportActorAvatars, false);
  }
}

async function adminPreviewActorAvatarCandidates() {
  setAdminBusy(els.adminPreviewActorAvatars, true, "读取中");
  els.adminStatus.textContent = "正在读取头像候选";
  if (els.adminActorAvatarCandidates) els.adminActorAvatarCandidates.innerHTML = "";
  try {
    const data = await api("/api/admin/actor-avatar-candidates", {
      method: "POST",
      body: { limit: 40 }
    });
    renderActorAvatarCandidates(data.summary || {});
  } catch (error) {
    els.adminStatus.textContent = error.message || "读取头像候选失败";
  } finally {
    setAdminBusy(els.adminPreviewActorAvatars, false);
  }
}

function renderActorAvatarCandidates(summary = {}) {
  if (!els.adminActorAvatarCandidates) return;
  els.adminActorAvatarCandidates.innerHTML = "";
  const people = summary.people || [];
  const matched = formatNumber(summary.matched || 0);
  const matchedPeople = formatNumber(summary.matchedPeople || 0);
  const returnedPeople = formatNumber(summary.returnedPeople || people.length);
  els.adminStatus.textContent = `头像候选：匹配 ${matched} 个文件，涉及 ${matchedPeople} 人，显示 ${returnedPeople} 人`;

  const note = document.createElement("p");
  note.className = "admin-avatar-note";
  note.textContent = `可用 ${formatNumber(summary.usable || 0)}，未匹配 ${formatNumber(summary.skippedUnmatched || 0)}，重名跳过 ${formatNumber(summary.skippedAmbiguous || 0)}`;
  els.adminActorAvatarCandidates.append(note);

  if (!people.length) {
    const empty = document.createElement("div");
    empty.className = "admin-avatar-empty";
    empty.textContent = "没有可选择的头像候选。";
    els.adminActorAvatarCandidates.append(empty);
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

    if ((person.candidates || []).length > 4) {
      const more = document.createElement("div");
      more.className = "admin-avatar-more";
      more.textContent = `还有 ${formatNumber(person.candidates.length - 4)} 个候选未显示`;
      card.append(more);
    }
    els.adminActorAvatarCandidates.append(card);
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
  metaLine.textContent = `${candidate.actorName || "未命名"} · ${formatBytes(candidate.size || 0)}`;
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
  setAdminBusy(button, true, "写入中");
  try {
    const data = await api("/api/admin/apply-actor-avatar-candidate", {
      method: "POST",
      body: { personId, relPath }
    });
    await loadLibrary();
    els.adminStatus.textContent = `已设置头像：${data.person?.actorProfile?.displayName || data.person?.name || personId}`;
    await adminPreviewActorAvatarCandidates();
  } catch (error) {
    els.adminStatus.textContent = error.message || "设置头像失败";
  } finally {
    setAdminBusy(button, false);
  }
}

async function refreshCoverCacheStatus() {
  if (!els.adminCoverStatus || els.adminModal.getAttribute("aria-hidden") === "true") return;
  els.adminCoverStatus.textContent = "正在统计缺封面";
  try {
    const data = await api("/api/admin/cover-cache-status?limit=0");
    const candidates = Number(data.candidates || 0);
    const ready = Number(data.ready || 0);
    const missingVideo = Number(data.missingVideo || 0);
    if (!candidates) {
      els.adminCoverStatus.textContent = "当前没有需要补齐的封面";
      return;
    }
    els.adminCoverStatus.textContent = `缺封面候选 ${formatNumber(candidates)}，可生成 ${formatNumber(ready)}，视频不可读 ${formatNumber(missingVideo)}`;
  } catch (error) {
    els.adminCoverStatus.textContent = error.message || "封面状态读取失败";
  }
}

async function adminGenerateMissingCovers() {
  const limit = Math.max(1, Math.min(200, Number(els.adminCoverLimit?.value || 20) || 20));
  if (els.adminCoverLimit) els.adminCoverLimit.value = String(limit);
  setAdminBusy(els.adminGenerateCovers, true, "启动中");
  els.adminStatus.textContent = "正在启动缺封面补齐任务";
  try {
    const data = await api("/api/admin/generate-missing-covers", {
      method: "POST",
      body: { limit }
    });
    els.adminStatus.textContent = `已启动：${data.task?.label || "任务"}`;
    if (els.adminCoverStatus) els.adminCoverStatus.textContent = "任务运行中，完成后刷新封面统计";
    await refreshAdminTasks();
    startAdminPolling();
  } catch (error) {
    els.adminStatus.textContent = error.message || "启动失败";
  } finally {
    setAdminBusy(els.adminGenerateCovers, false);
  }
}

async function saveCompilationConfig(config) {
  const normalized = normalizeUiConfig(config);
  const data = await api("/api/admin/settings/fanhao", {
    method: "PATCH",
    body: {
      values: {
        compilationPrefixes: normalized.compilationPrefixes,
        compilationKeywords: normalized.compilationKeywords
      }
    }
  });
  state.uiConfig = normalizeUiConfig({ ...state.uiConfig, ...(data.module?.values || {}) });
  resetWorkPaging();
  if (state.activeView === "people" && !state.selectedPersonId) {
    renderPeopleIndexStats();
    renderPeopleIndex();
  } else {
    renderWorks();
  }
  return state.uiConfig;
}

function openCompilationConfig() {
  window.location.assign("/admin#settings");
}

function openAdminPage() {
  window.location.assign("/admin");
}

function startAdminPolling() {
  stopAdminPolling();
  refreshAdminTasks();
  state.adminPollTimer = window.setInterval(refreshAdminTasks, 2500);
}

function stopAdminPolling() {
  if (state.adminPollTimer) {
    window.clearInterval(state.adminPollTimer);
    state.adminPollTimer = null;
  }
}

async function refreshAdminTasks() {
  if (!els.adminTaskList || els.adminModal.getAttribute("aria-hidden") === "true") return;
  try {
    const data = await api("/api/admin/tasks");
    const tasks = data.tasks || [];
    state.adminTasks = tasks;
    renderAdminTasks(tasks);
    renderAdminScripts();
    updateAdminOverview();
    await handleCompletedAdminTasks(tasks);
  } catch (error) {
    els.adminTaskList.innerHTML = `<div class="admin-empty">${error.message || "任务读取失败"}</div>`;
  }
}

async function handleCompletedAdminTasks(tasks) {
  for (const task of tasks) {
    if (task.status === "running" || task.status === "stopping" || state.handledAdminTaskIds.has(task.id)) continue;
    state.handledAdminTaskIds.add(task.id);
    if (task.status === "done" && task.type === "rankings") {
      state.rankingLists = [];
      if (state.activeView === "rankings") await loadRankings();
      els.adminStatus.textContent = "排行榜缓存已刷新";
      continue;
    }
    if (task.status === "done" && task.type === "covers") {
      await refreshCurrentWorkViewAfterAdminTask();
      await refreshCoverCacheStatus();
      els.adminStatus.textContent = "缺封面补齐任务已完成";
      continue;
    }
    if (task.status === "done" && task.personId && task.personId === state.selectedPersonId) {
      await selectPerson(task.personId, { resetFilter: false });
      els.adminStatus.textContent = "缺失检测已完成，当前人物已刷新";
    }
    if (task.status === "done" && task.scriptId) {
      await applyAdminTaskRefreshHints(task);
      if (els.adminScriptStatus) els.adminScriptStatus.textContent = `${task.label} 已完成`;
    }
  }
}

async function applyAdminTaskRefreshHints(task) {
  const hints = new Set(task.refreshHints || []);
  if (hints.has("library")) {
    await loadLibrary();
  }
  if (hints.has("image-library")) {
    state.gallery.data = null;
    state.gallery.status = "图库索引已刷新";
    if (state.activeView === "gallery") await loadImageLibrary({ reload: true });
  }
  if (hints.has("novels")) {
    if (state.novel) {
      state.novel.data = null;
      state.novel.summary = null;
      state.novel.book = null;
      state.novel.chapter = null;
      state.novel.status = "小说书库已刷新";
    }
    if (state.activeView === "novels" && loadNovels) await loadNovels({ reload: true });
  }
  if (hints.has("music")) {
    if (state.music) {
      state.music.data = null;
      state.music.summary = null;
      state.music.status = "音乐库已刷新";
    }
    if (state.activeView === "music" && loadMusic) await loadMusic({ reload: true, keepCurrent: true });
  }
  if (hints.has("rankings")) {
    state.rankingLists = [];
    if (state.activeView === "rankings") await loadRankings();
  }
  if (hints.has("covers")) {
    await refreshCoverCacheStatus();
  }
  if (hints.has("current-view")) {
    await refreshCurrentWorkViewAfterAdminTask();
  }
}

async function refreshCurrentWorkViewAfterAdminTask() {
  if (state.currentWork?.id) {
    try {
      const data = await api(`/api/works/${encodeURIComponent(state.currentWork.id)}`);
      state.currentWork = data.work || state.currentWork;
      updateWorkSnapshot(state.currentWork);
      renderPlayer(state.currentWork, state.currentVideo?.id);
      renderMeta(state.currentWork);
    } catch {}
  }
  if (state.selectedPersonId && state.activeView === "people") {
    await selectPerson(state.selectedPersonId, { resetFilter: false });
    return;
  }
  if (state.activeView === "favorites") {
    await loadFavorites();
    return;
  }
  if (state.activeView === "history") {
    await loadHistory();
    return;
  }
  renderWorks();
}

function renderAdminTasks(tasks) {
  els.adminTaskList.innerHTML = "";
  if (!tasks.length) {
    els.adminTaskList.innerHTML = `<div class="admin-empty">暂无任务</div>`;
    return;
  }

  for (const task of tasks) {
    const item = document.createElement("article");
    item.className = `admin-task ${task.status}`;
    const head = document.createElement("div");
    head.className = "admin-task-head";
    const title = document.createElement("div");
    title.className = "admin-task-title";
    const targetName = task.personName || (task.type === "rankings" ? "全局" : "未指定人物");
    title.textContent = `${task.label} · ${targetName}`;
    const status = document.createElement("span");
    status.className = `admin-task-status ${task.status}`;
    status.textContent = taskStatusLabel(task.status);
    head.append(title, status);
    if (task.canStop) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "folder-button compact";
      stop.textContent = "停止";
      stop.addEventListener("click", () => stopAdminTask(task.id, stop));
      head.append(stop);
    }

    const meta = document.createElement("div");
    meta.className = "admin-task-meta";
    const parts = [
      task.scriptId || task.type,
      task.pid ? `PID ${task.pid}` : "",
      task.startedAt ? `开始 ${formatDateTime(task.startedAt)}` : "",
      task.finishedAt ? `结束 ${formatDateTime(task.finishedAt)}` : "",
      task.exitCode !== null && task.exitCode !== undefined ? `退出码 ${task.exitCode}` : ""
    ].filter(Boolean);
    meta.textContent = parts.join(" · ");

    const log = document.createElement("pre");
    log.textContent = (task.logs || []).slice(-18).join("\n");
    item.append(head, meta, log);
    els.adminTaskList.append(item);
  }
}

function taskStatusLabel(status) {
  const labels = {
    running: "运行中",
    stopping: "停止中",
    stopped: "已停止",
    done: "完成",
    error: "异常"
  };
  return labels[status] || status || "-";
}

  return {
    applyTaskRefreshHints: applyAdminTaskRefreshHints,
    closeModal: closeAdminModal,
    generateMissingCovers: adminGenerateMissingCovers,
    importActorAvatars: adminImportActorAvatars,
    loadScripts: loadAdminScripts,
    openCompilationConfig,
    openModal: openAdminModal,
    openPage: openAdminPage,
    previewActorAvatarCandidates: adminPreviewActorAvatarCandidates,
    refreshActorMovies: adminRefreshActorMovies,
    refreshRankings: adminRefreshRankings,
    refreshTasks: refreshAdminTasks,
    renderScripts: renderAdminScripts,
    rescanSelectedPerson: adminRescanSelectedPerson,
    runSelectedScript: runSelectedAdminScript,
    saveCompilationConfigData: saveCompilationConfig,
    selectScript: selectAdminScript,
    setBusy: setAdminBusy,
    startPolling: startAdminPolling,
    stopPolling: stopAdminPolling
  };
}
