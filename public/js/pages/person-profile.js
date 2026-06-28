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
  const avatarUrl = profile?.avatarUrl || coverUrl(person.coverId);
  const displayName = profile?.displayName || person.name;
  const aliases = profile?.aliases || [];

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
      avatar.textContent = person.name.slice(0, 2);
      avatar.classList.add("empty");
    });
    avatar.append(img);
  } else {
    avatar.classList.add("empty");
    avatar.textContent = person.name.slice(0, 2);
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
    nameRow.append(editButton);
  }

  const sub = document.createElement("div");
  sub.className = "person-profile-sub";
  sub.textContent = aliases.length ? aliases.join("、") : formatLibraryPaths(person.sourcePaths || [person.relativePath]);

  const metrics = document.createElement("div");
  metrics.className = "person-profile-metrics";
  const hasActorCache = (person.actorMovieCount ?? profile?.movieCount ?? 0) > 0 || Boolean(profile?.javdbUrl);
  metrics.append(createProfileMetric("作品", person.workCount), createProfileMetric("视频", person.videoCount));
  if (hasActorCache) {
    metrics.append(
      createProfileMetric("JavDB", person.actorMovieCount ?? profile?.movieCount ?? 0),
      createProfileMetric("未下载", person.missingLocalWorkCount ?? 0)
    );
  } else {
    metrics.append(createProfileMetric("可播", person.playableCount));
  }

  copy.append(nameRow, sub, metrics);
  const editor = state.accessMode === "local" ? createActorProfileEditor(person, profile) : null;
  const actions = createPersonProfileActions(person);
  if (editor) {
    copy.append(editor);
    const editButton = nameRow.querySelector("button.person-profile-link");
    editButton?.addEventListener("click", () => {
      editor.hidden = !editor.hidden;
      if (!editor.hidden) editor.querySelector("input")?.focus();
    });
  }
  if (actions) copy.append(actions);
  els.personProfile.append(avatar, copy);
}

function createActorProfileEditor(person, profile) {
  const form = document.createElement("form");
  form.className = "actor-config-form";
  form.hidden = Boolean(profile?.javdbUrl);

  const urlLabel = document.createElement("label");
  urlLabel.className = "actor-config-field wide";
  const urlText = document.createElement("span");
  urlText.textContent = "JavDB actor 页";
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.placeholder = "https://javdb.com/actors/BzpA";
  urlInput.value = profile?.javdbUrl || "";
  urlInput.required = true;
  urlLabel.append(urlText, urlInput);

  const nameLabel = document.createElement("label");
  nameLabel.className = "actor-config-field";
  const nameText = document.createElement("span");
  nameText.textContent = "显示名";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = profile?.displayName || person.name;
  nameLabel.append(nameText, nameInput);

  const aliasesLabel = document.createElement("label");
  aliasesLabel.className = "actor-config-field wide";
  const aliasesText = document.createElement("span");
  aliasesText.textContent = "别名 / 曾用名";
  const aliasesInput = document.createElement("textarea");
  aliasesInput.rows = 3;
  aliasesInput.spellcheck = false;
  aliasesInput.placeholder = "一行一个，也可用逗号、顿号分隔";
  aliasesInput.value = (profile?.aliases || []).join("\n");
  aliasesLabel.append(aliasesText, aliasesInput);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "folder-button";
  submit.textContent = "保存映射";

  const status = document.createElement("span");
  status.className = "actor-config-status";

  form.append(urlLabel, nameLabel, aliasesLabel, submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveActorProfileMapping(person, {
      javdbUrl: urlInput.value,
      displayName: nameInput.value,
      aliases: linesFromTextarea(aliasesInput.value),
      button: submit,
      status
    });
  });
  return form;
}

async function saveActorProfileMapping(person, options) {
  const originalText = options.button.textContent;
  options.button.disabled = true;
  options.button.textContent = "保存中";
  options.status.textContent = "";

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
    options.status.textContent = "已保存";
    await selectPerson(person.id, { resetFilter: false });
  } catch (error) {
    options.status.textContent = error.message || "保存失败";
  } finally {
    options.button.disabled = false;
    options.button.textContent = originalText;
  }
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

function createProfileMetric(label, value) {
  const item = document.createElement("span");
  item.innerHTML = `<strong></strong><small></small>`;
  item.querySelector("strong").textContent = formatNumber(value);
  item.querySelector("small").textContent = label;
  return item;
}

  return {
    hide: hidePersonProfile,
    render: renderPersonProfile
  };
}
