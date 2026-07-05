export function createPersonProfile(deps) {
  const {
    api,
    coverUrl,
    els,
    formatLibraryPath,
    formatLibraryPaths,
    formatNumber,
    linesFromTextarea,
    normalizeSourcePath,
    renderPeople,
    selectPerson,
    sourcePriority,
    state
  } = deps;

function uniqueSourcePaths(person) {
  const seen = new Set();
  return [...(person.sourcePaths || []), person.relativePath]
    .filter(Boolean)
    .filter((sourcePath) => {
      const key = normalizeSourcePath(sourcePath);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => sourcePriority(a) - sourcePriority(b));
}

function sourceButtonLabel(sourcePath) {
  const normalized = normalizeSourcePath(sourcePath);
  if (normalized === "v:/[a]" || normalized.startsWith("v:/[a]/")) return "打开 VR · V:[A]";
  if (normalized === "v:/[a1]" || normalized.startsWith("v:/[a1]/")) return "打开 VR · V:[A1]";
  if (normalized === "v:/av" || normalized.startsWith("v:/av/")) return "打开 VR · V:AV";
  if (normalized.startsWith("v:/")) return "打开 VR";
  if (normalized === "o:/[珍藏]" || normalized.startsWith("o:/[珍藏]/")) return "打开珍藏 · O:";
  if (normalized === "o:/[珍藏1]" || normalized.startsWith("o:/[珍藏1]/")) return "打开珍藏1 · O:";
  if (normalized.startsWith("g:/")) return "打开普通 · G:";
  if (normalized.startsWith("f:/")) return "打开普通 · F:";
  if (normalized.startsWith("o:/")) return "打开普通 · O:";
  return "打开文件夹";
}

function hidePersonProfile() {
  if (!els.personProfile) return;
  els.personProfile.hidden = true;
  els.personProfile.classList.remove("ranking-profile-panel");
  els.personProfile.innerHTML = "";
}

function renderPersonProfile(person) {
  if (!els.personProfile || !person) return;

  const profile = person.actorProfile || null;
  const avatarUrl = person.avatarUrl || profile?.avatarUrl || coverUrl(person.coverId);
  const displayName = profile?.displayName || person.name;

  els.personProfile.hidden = false;
  els.personProfile.classList.remove("ranking-profile-panel");
  els.personProfile.innerHTML = "";

  const avatar = document.createElement("div");
  avatar.className = "person-avatar";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = avatarUrl;
    img.addEventListener("error", () => {
      img.remove();
      avatar.textContent = displayName.slice(0, 2);
      avatar.classList.add("empty");
    });
    avatar.append(img);
  } else {
    avatar.classList.add("empty");
    avatar.textContent = displayName.slice(0, 2);
  }

  const copy = document.createElement("div");
  copy.className = "person-profile-copy";

  const nameRow = document.createElement("div");
  nameRow.className = "person-profile-name-row";

  const title = document.createElement("h3");
  title.textContent = displayName;
  nameRow.append(title);

  if (profile?.javdbUrl) {
    const link = document.createElement("a");
    link.className = "person-profile-link";
    link.href = profile.javdbUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.title = "打开外部资料页";
    link.textContent = "资料页";
    nameRow.append(link);
  }

  if (state.accessMode === "local") {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "person-profile-link";
    editButton.textContent = profile?.javdbUrl ? "编辑映射" : "配置资料页";
    editButton.addEventListener("click", () => openActorMappingModal(person));
    nameRow.append(editButton);
  }

  const summary = createProfileSummary(person, profile);

  copy.append(nameRow, summary);
  const actions = createPersonProfileActions(person);
  if (actions) copy.append(actions);
  els.personProfile.append(avatar, copy);
}

async function saveActorProfileMapping(person, options) {
  const originalText = options.button?.textContent || "";
  if (options.button) {
    options.button.disabled = true;
    options.button.textContent = "保存中";
  }
  if (options.status) options.status.textContent = "";

  try {
    const data = await api(`/api/actor-profiles/${encodeURIComponent(person.id)}`, {
      method: "PUT",
      body: {
        javdbUrl: options.javdbUrl,
        displayName: options.displayName || person.name,
        aliases: options.aliases || [],
        source: "manual",
        status: "ok"
      }
    });
    updatePersonActorProfile(person.id, data.profile);
    if (options.status) options.status.textContent = "已保存";
    await selectPerson(person.id, { resetFilter: false });
  } catch (error) {
    if (options.status) options.status.textContent = error.message || "保存失败";
    if (options.throwOnError) throw error;
  } finally {
    if (options.button) {
      options.button.disabled = false;
      options.button.textContent = originalText;
    }
  }
}

function createMappingField(labelText, control) {
  const label = document.createElement("label");
  label.className = "mapping-field";
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

function mappingButton(label, className = "folder-button") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function selectedSourcePaths(container) {
  return [...container.querySelectorAll("input[data-source-path]:checked")]
    .map((input) => input.dataset.sourcePath)
    .filter(Boolean);
}

function setButtonBusy(button, busy, text = "") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    if (text) button.textContent = text;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }
}

function mappingAliasValues(person, profile) {
  const primaryNames = new Set([person?.name, profile?.displayName, profile?.personName].filter(Boolean).map(normalizePersonNameValue));
  return (profile?.aliases || []).filter((alias) => {
    const key = normalizePersonNameValue(alias);
    return key && !primaryNames.has(key);
  });
}

function normalizePersonNameValue(value) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

async function openActorMappingModal(person) {
  const initialProfile = person.actorProfile || {};
  const overlay = document.createElement("div");
  overlay.className = "mapping-modal-backdrop";
  overlay.setAttribute("role", "presentation");

  const modal = document.createElement("section");
  modal.className = "mapping-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "编辑人物映射");

  const header = document.createElement("header");
  header.className = "mapping-modal-header";
  const heading = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = "编辑映射";
  const subtitle = document.createElement("p");
  subtitle.textContent = person.actorProfile?.displayName || person.name;
  heading.append(title, subtitle);
  const close = mappingButton("关闭", "folder-button compact");
  header.append(heading, close);

  const content = document.createElement("div");
  content.className = "mapping-modal-content";

  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.placeholder = "https://javdb.com/actors/BzpA";
  urlInput.value = initialProfile.javdbUrl || "";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = initialProfile.displayName || person.name;

  const aliasesInput = document.createElement("textarea");
  aliasesInput.rows = 4;
  aliasesInput.spellcheck = false;
  aliasesInput.placeholder = "一行一个，也可用逗号、顿号分隔";
  aliasesInput.value = mappingAliasValues(person, initialProfile).join("\n");

  const javdbSection = document.createElement("section");
  javdbSection.className = "mapping-section";
  const javdbHead = document.createElement("div");
  javdbHead.className = "mapping-section-head";
  javdbHead.innerHTML = "<strong>JavDB 映射</strong><span>保存 actor 页、显示名和别名</span>";
  const javdbGrid = document.createElement("div");
  javdbGrid.className = "mapping-grid";
  javdbGrid.append(
    createMappingField("JavDB actor 页", urlInput),
    createMappingField("显示名", nameInput),
    createMappingField("别名 / 曾用名", aliasesInput)
  );
  javdbSection.append(javdbHead, javdbGrid);

  const sourceSection = document.createElement("section");
  sourceSection.className = "mapping-section";
  const sourceHead = document.createElement("div");
  sourceHead.className = "mapping-section-head";
  sourceHead.innerHTML = "<strong>本地来源</strong><span>选择这个人物对应的盘符和文件夹</span>";
  const manualRow = document.createElement("div");
  manualRow.className = "mapping-source-manual";
  const manualInput = document.createElement("input");
  manualInput.type = "text";
  manualInput.placeholder = "例如 O:/[珍藏1]/本庄鈴";
  const addManual = mappingButton("加入候选", "folder-button compact");
  manualRow.append(manualInput, addManual);
  const sourceList = document.createElement("div");
  sourceList.className = "mapping-source-list";
  sourceSection.append(sourceHead, manualRow, sourceList);

  const footer = document.createElement("footer");
  footer.className = "mapping-modal-footer";
  const status = document.createElement("span");
  status.className = "mapping-status";
  const syncLocal = mappingButton("扫描本地并同步表单");
  const refreshJavdb = mappingButton("访问 JavDB 更新片单");
  const refreshAllJavdb = mappingButton("全量扫描有链接人物");
  const save = mappingButton("保存映射");
  footer.append(status, syncLocal, refreshJavdb, refreshAllJavdb, save);

  content.append(javdbSection, sourceSection);
  modal.append(header, content, footer);
  overlay.append(modal);
  document.body.append(overlay);

  let manualSourcePaths = [];
  let modalPerson = person;

  const closeModal = () => overlay.remove();
  close.addEventListener("click", closeModal);

  async function loadMapping() {
    status.textContent = "正在同步映射";
    const query = manualSourcePaths.map((sourcePath) => `sourcePath=${encodeURIComponent(sourcePath)}`).join("&");
    const data = await api(`/api/admin/person-mapping/${encodeURIComponent(modalPerson.id)}${query ? `?${query}` : ""}`);
    modalPerson = data.person || modalPerson;
    renderSourceCandidates(data.sourceCandidates || []);
    status.textContent = "映射已同步";
  }

  function renderSourceCandidates(candidates) {
    sourceList.innerHTML = "";
    const visibleCandidates = candidates.filter((candidate) => candidate.selected || manualSourcePaths.some((item) => normalizeSourcePath(item) === normalizeSourcePath(candidate.sourcePath)));
    if (!visibleCandidates.length) {
      const empty = document.createElement("div");
      empty.className = "mapping-source-empty";
      empty.textContent = "未选择本地来源。需要时在上方手动添加路径。";
      sourceList.append(empty);
      return;
    }

    for (const candidate of visibleCandidates) {
      const row = document.createElement("label");
      row.className = `mapping-source-row${candidate.exists ? "" : " missing"}`;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.sourcePath = candidate.sourcePath;
      checkbox.checked = Boolean((candidate.selected || manualSourcePaths.some((item) => normalizeSourcePath(item) === normalizeSourcePath(candidate.sourcePath))) && candidate.exists);
      checkbox.disabled = !candidate.exists;
      const main = document.createElement("span");
      main.className = "mapping-source-main";
      main.textContent = candidate.sourcePath;
      const meta = document.createElement("span");
      meta.className = "mapping-source-meta";
      meta.textContent = `${candidate.root || "资料库"} · ${candidate.exists ? "已存在" : "未找到"}`;
      row.append(checkbox, main, meta);
      sourceList.append(row);
    }
  }

  addManual.addEventListener("click", async () => {
    const value = manualInput.value.trim();
    if (!value) return;
    if (!manualSourcePaths.some((item) => normalizeSourcePath(item) === normalizeSourcePath(value))) {
      manualSourcePaths.push(value);
    }
    manualInput.value = "";
    try {
      await loadMapping();
    } catch (error) {
      status.textContent = error.message || "加入候选失败";
    }
  });

  save.addEventListener("click", async () => {
    await saveActorProfileMapping(modalPerson, {
      javdbUrl: urlInput.value,
      displayName: nameInput.value,
      aliases: linesFromTextarea(aliasesInput.value),
      button: save,
      status
    });
  });

  syncLocal.addEventListener("click", async () => {
    setButtonBusy(syncLocal, true, "扫描中");
    status.textContent = "正在扫描选中的本地来源";
    try {
      const sourcePaths = selectedSourcePaths(sourceList);
      const data = await api(`/api/admin/rescan-person?limit=1&sort=releaseDesc`, {
        method: "POST",
        body: { personId: modalPerson.id, sourcePaths }
      });
      modalPerson = data.person || modalPerson;
      await selectPerson(modalPerson.id, { resetFilter: false });
      await loadMapping();
      status.textContent = `本地已同步：${formatNumber(modalPerson.workCount)} 部`;
    } catch (error) {
      status.textContent = error.message || "扫描失败";
    } finally {
      setButtonBusy(syncLocal, false);
    }
  });

  refreshJavdb.addEventListener("click", async () => {
    setButtonBusy(refreshJavdb, true, "访问中");
    status.textContent = "正在启动 JavDB 更新";
    try {
      await saveActorProfileMapping(modalPerson, {
        javdbUrl: urlInput.value,
        displayName: nameInput.value,
        aliases: linesFromTextarea(aliasesInput.value),
        status: null,
        throwOnError: true
      });
      const data = await api("/api/admin/refresh-actor-movies", {
        method: "POST",
        body: { personId: modalPerson.id, sleep: 1, maxPages: 1 }
      });
      status.textContent = `JavDB 任务已启动：${data.task?.id || ""}`;
      await waitForAdminTask(data.task?.id, status);
      await selectPerson(modalPerson.id, { resetFilter: false });
      await loadMapping();
      status.textContent = "JavDB 片单已更新";
    } catch (error) {
      status.textContent = error.message || "JavDB 更新失败";
    } finally {
      setButtonBusy(refreshJavdb, false);
    }
  });

  refreshAllJavdb.addEventListener("click", async () => {
    setButtonBusy(refreshAllJavdb, true, "扫描中");
    status.textContent = "正在启动全量 JavDB 扫描";
    try {
      const data = await api("/api/admin/refresh-actor-movies", {
        method: "POST",
        body: { fullScan: true, sleep: 1, maxPages: 0 }
      });
      status.textContent = `全量任务已启动：${data.task?.id || ""}`;
      await waitForAdminTask(data.task?.id, status);
      await selectPerson(modalPerson.id, { resetFilter: false });
      await loadMapping();
      status.textContent = "全量 JavDB 扫描已完成";
    } catch (error) {
      status.textContent = error.message || "全量扫描失败";
    } finally {
      setButtonBusy(refreshAllJavdb, false);
    }
  });

  try {
    await loadMapping();
  } catch (error) {
    status.textContent = error.message || "映射读取失败";
  }

  window.setTimeout(() => urlInput.focus(), 0);
}

async function waitForAdminTask(taskId, status) {
  if (!taskId) return;
  for (let index = 0; index < 180; index += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    const data = await api("/api/admin/tasks");
    const task = (data.tasks || []).find((item) => item.id === taskId);
    if (!task) continue;
    status.textContent = `JavDB ${task.status}${task.logs?.length ? ` · ${task.logs.at(-1)}` : ""}`;
    if (task.status === "done") return;
    if (task.status === "error" || task.status === "stopped") {
      throw new Error(task.logs?.at(-1) || "JavDB 更新失败");
    }
  }
  throw new Error("JavDB 更新还在运行，请稍后刷新查看");
}

function updatePersonActorProfile(personId, profile) {
  state.people = state.people.map((person) => (person.id === personId ? { ...person, actorProfile: profile } : person));
  if (state.selectedPerson?.id === personId) {
    state.selectedPerson = { ...state.selectedPerson, actorProfile: profile, actorMovieCount: 0, missingLocalWorkCount: 0 };
  }
  renderPeople();
}

function createPersonProfileActions(person) {
  if (state.accessMode !== "local") return null;
  const paths = uniqueSourcePaths(person);
  if (!paths.length) return null;

  const actions = document.createElement("div");
  actions.className = "person-profile-actions";

  for (const sourcePath of paths) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-button";
    button.textContent = sourceButtonLabel(sourcePath);
    button.title = formatLibraryPath(sourcePath);
    button.addEventListener("click", () => openLocalFolder(sourcePath, button));
    actions.append(button);
  }

  return actions;
}

async function openLocalFolder(sourcePath, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "打开中";

  try {
    await api("/api/open-folder", { method: "POST", body: { sourcePath } });
    button.textContent = "已打开";
    window.setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1200);
  } catch (error) {
    button.textContent = "打开失败";
    button.title = error.message || "打开失败";
    window.setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
      button.title = formatLibraryPath(sourcePath);
    }, 2000);
  }
}

function createProfileSummary(person, profile) {
  const item = document.createElement("div");
  item.className = "person-profile-summary";
  const parts = [`本地 ${formatNumber(person.workCount)} 部 / ${formatNumber(person.videoCount)} 视频`];
  const actorCount = person.actorMovieCount ?? profile?.movieCount ?? 0;
  if (actorCount > 0 || profile?.javdbUrl) {
    parts.push(`JavDB ${formatNumber(actorCount)}`);
    const missing = person.missingLocalWorkCount ?? 0;
    if (missing > 0) parts.push(`未下载 ${formatNumber(missing)}`);
  } else if (person.playableCount) {
    parts.push(`可播 ${formatNumber(person.playableCount)}`);
  }
  item.textContent = parts.join(" · ");
  return item;
}

  return {
    hide: hidePersonProfile,
    render: renderPersonProfile
  };
}
