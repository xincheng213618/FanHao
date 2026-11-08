export function createIntake({ api, endpoint, node, setStatus, sourceUrl, appendArchiveLinks, localCollectionKey, onSaved }) {
  const panel = document.querySelector("#intake-panel");
  const previewForm = document.querySelector("#intake-preview-form");
  const confirmForm = document.querySelector("#intake-confirm-form");
  const previewButton = document.querySelector("#intake-preview-button");
  const sampleButton = document.querySelector("#intake-sample-source");
  const commitButton = document.querySelector("#intake-commit-button");
  const status = document.querySelector("#intake-status");
  const example = document.querySelector("#intake-example");
  const linkedWorks = document.querySelector("#intake-linked-works");
  const planTitle = document.querySelector("#intake-plan-title");
  const activeSource = document.querySelector("#intake-active-source");
  const warnings = document.querySelector("#intake-warnings");
  const sourceCollections = document.querySelector("#intake-source-collections");
  const changes = document.querySelector("#intake-changes");
  const actions = document.querySelector("#intake-actions");
  const next = document.querySelector("#intake-next");
  const nextButton = document.querySelector("#intake-next-button");
  const receipt = document.querySelector("#intake-receipt");
  const receiptStatus = document.querySelector("#receipt-status");
  const receiptResults = document.querySelector("#receipt-results");
  const previewFields = previewForm.elements;
  const confirmed = confirmForm.elements.confirmed;
  const modeFields = [
    ["source", "#source-field", previewFields.url],
    ["source", "#source-local-field", previewFields.sourceLocalCollectionId],
    ["local", "#local-field", previewFields.localCollectionId],
    ["manifest", "#manifest-field", previewFields.manifest]
  ];
  let sampleSourceUrl = "";
  let optionsError = "";
  let optionsRequested = false;
  let intakeAllowed = true;
  let busy = false;
  let plan = null;
  let rows = [];
  let previewRequest;
  let nextRequest;
  let pendingCommit;
  let manifestFile;

  function updateMode() {
    const mode = previewFields.mode.value;
    previewFields.mode.disabled = busy || !intakeAllowed;
    for (const [fieldMode, selector, input] of modeFields) {
      document.querySelector(selector).hidden = fieldMode !== mode;
      input.disabled = busy || !intakeAllowed || fieldMode !== mode;
    }
    const showArchiveQuery = mode === "source" && Boolean(previewFields.sourceLocalCollectionId.value);
    document.querySelector("#source-query-field").hidden = !showArchiveQuery;
    previewFields.archiveQuery.disabled = busy || !intakeAllowed || !showArchiveQuery;
    previewFields.manifestFile.disabled = busy || !intakeAllowed || mode !== "manifest";
    sampleButton.hidden = mode !== "source" || !sampleSourceUrl || !intakeAllowed;
    sampleButton.disabled = busy || Boolean(manifestFile);
    example.textContent = mode === "manifest"
      ? "粘贴微密圈归档导入工具生成的原始 JSON 清单。预览仅匹配图库已经扫描到的归档。"
      : sampleSourceUrl && mode === "source"
        ? "可从公开合集目录开始，也可填写单个分类、合集或单期的地址。"
        : "";
    if (mode !== "manifest" && optionsError) {
      example.textContent = [example.textContent, optionsError].filter(Boolean).join(" ");
    }
    example.hidden = !example.textContent;
  }

  async function loadOptions() {
    if (!panel.open || optionsRequested) return;
    optionsRequested = true;
    try {
      const options = await api(`${endpoint}/intake/options`);
      sampleSourceUrl = options.sampleSourceUrl || "";
      const localCollections = options.localCollections || [];
      for (const collection of localCollections) {
        const title = [...new Set([collection.title, collection.category, collection.directory, collection.rootLabel].filter(Boolean))].join(" · ");
        const label = collection.count == null ? title : `${title}（${collection.count} 包）`;
        for (const select of [previewFields.localCollectionId, previewFields.sourceLocalCollectionId]) {
          select.add(new Option(label, collection.id));
        }
      }
      if (localCollectionKey) {
        const folder = localCollections.find(({ legacyKey }) => legacyKey === localCollectionKey);
        if (!folder) {
          optionsError = "无法定位链接中的扫描目录，请重新选择。";
        } else {
          previewFields.localCollectionId.value = folder.id;
          previewFields.sourceLocalCollectionId.value = folder.id;
          if (folder.catalogKey) {
            const url = new URL(location.pathname, location.href);
            url.searchParams.set("localCollection", localCollectionKey);
            url.searchParams.set("collection", folder.catalogKey);
            url.hash = "#directory";
            linkedWorks.querySelector("a").href = url.href;
            linkedWorks.hidden = false;
          }
        }
      }
    } catch (error) {
      intakeAllowed = error.status !== 401 && error.status !== 403;
      optionsError = intakeAllowed ? "读取扫描目录失败。刷新页面可以重新加载目录。" : "入库工作台需要本机管理员权限。";
    } finally {
      updateControls();
    }
  }

  function post(path, body) {
    return api(`${endpoint}/intake/${path}`, { method: "POST", body });
  }

  function requestFromForm() {
    const mode = previewFields.mode.value;
    if (mode === "source") {
      const url = previewFields.url.value.trim();
      const localCollectionId = previewFields.sourceLocalCollectionId.value;
      const archiveQuery = previewFields.archiveQuery.value.trim();
      return {
        mode, url, ...(localCollectionId ? { localCollectionId, ...(archiveQuery ? { archiveQuery } : {}) } : {})
      };
    }
    if (mode === "local") return { mode, localCollectionId: previewFields.localCollectionId.value };
    try {
      return { mode, manifest: JSON.parse(previewFields.manifest.value) };
    } catch {
      throw new Error("JSON 清单格式有误。请粘贴完整的导入清单。");
    }
  }

  function showPlanMessages(list, messages = []) {
    list.replaceChildren(...messages.map((message) => node("li", "", messageText(message))));
    list.hidden = !list.childElementCount;
  }

  function messageText(message) {
    if (typeof message === "string") return message;
    if (message?.code === "merge-field-conflict") {
      const labels = { title: "标题", issueCode: "期号", releaseDate: "发行日期" };
      return `两条记录的${labels[message.id] || "资料"}不同，请确认合并后保留的值`;
    }
    const labels = {
      "archive-owned": "本地包已关联其他作品",
      "source-owned": "来源已关联其他作品",
      "archive-not-found": "未找到该扫描包",
      "work-not-found": "关联作品已变化",
      "person-not-found": "未找到该人物",
      "person-duplicate": "重复的人物记录",
      "merge-target-has-source": "本地作品已有关联来源，请重新预览",
      "merge-donor-has-archive": "来源作品已有关联本地包，请重新预览",
      "merge-archive-unbound": "本地包的关联已变化，请重新预览",
      "merge-source-unbound": "来源的关联已变化，请重新预览"
    };
    return message?.message || labels[message?.code] || message?.error || message?.code || "需要检查该条资料";
  }

  function sourceCollectionFacts(collection) {
    return [collection.declaredCountLabel, collection.declaredSizeLabel].filter(Boolean).join(" · ");
  }

  function sourceDirectoryItem(collection) {
    const row = node("li");
    row.append(node("h3", "", collection.name || "来源合集"));
    const details = sourceCollectionFacts(collection);
    if (details) row.append(node("p", "details", `来源标注 ${details}`));
    const url = sourceUrl(collection.issueListUrl || collection.url);
    if (url && url.href !== sourceUrl(previewRequest.url)?.href) {
      const button = node("button", "secondary", "预览单期列表");
      button.type = "button";
      button.addEventListener("click", () => {
        const { offset, sourceCollectionUrl, ...request } = previewRequest;
        void preview({ ...request, url: url.href });
      });
      row.append(button);
    }
    return row;
  }

  function inputField(tag, text, value = "", { type, placeholder } = {}) {
    const label = node("label", "", text);
    const input = node(tag);
    if (type) input.type = type;
    if (placeholder) input.placeholder = placeholder;
    input.value = value;
    input.defaultValue = input.value;
    label.append(input);
    return { label, input };
  }

  function checkbox(text, checked = false) {
    const field = inputField("input", text, "", { type: "checkbox" });
    field.label.className = "check";
    field.label.prepend(field.input);
    field.input.checked = checked;
    return field;
  }

  function previewRow(change) {
    const card = node("li");
    const title = change.title || change.issueCode || "未命名套图";
    card.append(node("h3", "", title));
    const source = change.source;
    const sourceDetails = [
      change.issueCode && change.issueCode !== title && change.issueCode,
      source?.issueLabel && `标注期号 ${source.issueLabel}`,
      source?.declaredImageCount != null && `${source.declaredImageCount} 张`,
      source?.declaredVideoCount != null && `${source.declaredVideoCount} 段视频`,
      source?.declaredSizeLabel
    ].filter(Boolean);
    if (sourceDetails.length) card.append(node("p", "details", sourceDetails.join(" · ")));
    if (change.manifestObservation?.observedImageCount != null) {
      card.append(node("p", "details", `清单记录 ${change.manifestObservation.observedImageCount} 张`));
    }
    const url = sourceUrl(source?.url);
    if (url) {
      const link = node("a", "", "打开来源");
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      card.append(link);
    }
    const candidates = change.candidates || [];
    const existing = candidates.find(({ id }) => id === change.workId) || change.existing;
    if (existing || change.workId) {
      card.append(node("p", "details", `关联已有作品 ${existing?.title || existing?.issueCode || existing?.id || change.workId}`));
    }
    const otherCandidates = candidates.filter(({ id }) => id !== change.workId).map(({ title, issueCode, id }) => title || issueCode || id);
    if (otherCandidates.length) card.append(node("p", "details", `请核对相似作品 ${otherCandidates.join("、")}`));
    const conflicts = node("ul", "warnings");
    showPlanMessages(conflicts, [...(change.conflicts || []), ...(change.warnings || [])]);
    if (!conflicts.hidden) card.append(conflicts);
    if (!change.canCommit) {
      card.append(node("p", "details", "该条资料暂不能入库。"));
      return { card };
    }

    const included = checkbox("选择此条入库", true);
    card.append(included.label);
    const edits = node("div", "row-edit");
    const titleField = inputField("input", "标题", change.title);
    titleField.input.required = true;
    const issue = inputField("input", "期号", change.issueCode);
    const people = change.people || [];
    const roleFields = [
      ["model", "出镜人物（选填，以逗号分隔）"],
      ["creator", "归属/创作者（选填，以逗号分隔）"]
    ].map(([role, label]) => ({
      role, ...inputField("input", label, people.filter((person) => (person.role || "model") === role).map(({ name }) => name).join("、"))
    }));
    const release = inputField("input", "发行日期（选填）", change.releaseDate || source?.releaseDate || "", { type: "date" });
    edits.append(titleField.label, issue.label, ...roleFields.map(({ label }) => label), release.label);
    card.append(edits);

    const archives = node("fieldset", "archive-options");
    archives.append(node("legend", "", "关联本地包"));
    const localAlbums = change.localAlbums || [];
    const requiredArchive = !source && localAlbums.length === 1;
    const archiveOptions = localAlbums.map((archive) => {
      const label = [archive.title || "本地包", archive.personName].filter(Boolean).join(" · ");
      const choice = checkbox(label, (change.archiveIds || []).includes(archive.id));
      choice.input.disabled = requiredArchive;
      archives.append(choice.label);
      return { id: archive.id, input: choice.input };
    });
    if (archiveOptions.length) card.append(archives);
    const editControls = [titleField.input, issue.input, release.input, ...roleFields.map(({ input }) => input)];
    if (!requiredArchive) editControls.push(...archiveOptions.map(({ input }) => input));
    const merge = checkbox("合并两条已有作品");
    const mergeStatus = node("p", "field-help");
    const mergeArea = node("div", "merge-area");
    const mergeFields = node("div", "row-edit");
    const mergeInputs = {
      title: { label: "标题", input: titleField.input },
      issueCode: { label: "期号", input: issue.input },
      releaseDate: { label: "发行日期", input: release.input }
    };
    mergeArea.hidden = true;
    mergeArea.append(mergeStatus, merge.label, mergeFields);
    if (change.mergeCandidates?.length) card.append(mergeArea);
    let pair;
    let fieldChoices = [];
    let needsMerge = false;

    function showMergeFields(fieldConflicts = []) {
      fieldChoices = fieldConflicts.map(({ field, localValue, sourceValue }) => {
        const { label, input } = mergeInputs[field];
        const control = inputField("select", `合并后保留的${label}`);
        control.input.append(
          new Option("请选择", ""),
          new Option(`本地 · ${localValue}`, "local"),
          new Option(`来源 · ${sourceValue}`, "source"),
          new Option("使用上方手动填写的值", "manual")
        );
        return {
          field, ...control,
          value: () => ({ local: localValue, source: sourceValue, manual: input.value.trim() })[control.input.value]
        };
      });
      mergeFields.replaceChildren(...fieldChoices.map(({ label }) => label));
    }

    function updateMerge(locked) {
      const selected = new Set(archiveOptions.filter(({ input }) => input.checked).map(({ id }) => id));
      const matching = (change.mergeCandidates || []).filter(({ archiveId }) => included.input.checked && selected.has(archiveId));
      const pairs = new Map(matching.map((candidate) => [JSON.stringify([candidate.localWorkId, candidate.sourceWorkId]), candidate]));
      const candidate = pairs.size === 1 ? pairs.values().next().value : null;
      if (pair?.localWorkId !== candidate?.localWorkId || pair?.sourceWorkId !== candidate?.sourceWorkId) {
        merge.input.checked = false;
        showMergeFields(candidate?.fieldConflicts);
      }
      pair = candidate;
      mergeArea.hidden = !pairs.size;
      merge.label.hidden = !pair;
      merge.input.disabled = locked || !pair;
      mergeStatus.textContent = pair
        ? `本地作品「${pair.localTitle}」与来源作品「${pair.sourceTitle}」已分别入库。确认后会合并记录。`
        : "本批每条资料只能合并一对已有作品。请调整关联本地包。";
      mergeFields.hidden = !merge.input.checked || !fieldChoices.length;
      for (const { input } of fieldChoices) input.disabled = locked || mergeFields.hidden;
      needsMerge = pairs.size > 0 && (!pair || !merge.input.checked || fieldChoices.some(({ value }) => !value()));
    }

    function body() {
      const selected = new Set(archiveOptions.map(({ id }) => id));
      const archiveIds = [
        ...(change.archiveIds || []).filter((id) => !selected.has(id)),
        ...archiveOptions.filter(({ input }) => input.checked).map(({ id }) => id)
      ];
      const result = { key: change.key, archiveIds };
      if (titleField.input.value.trim() !== (change.title || "")) result.title = titleField.input.value.trim();
      if (issue.input.value.trim() !== (change.issueCode || "")) result.issueCode = issue.input.value.trim();
      const editedRoles = roleFields.filter(({ input }) => input.value !== input.defaultValue);
      if (editedRoles.length) {
        result.people = people.filter((person) => !editedRoles.some(({ role }) => role === (person.role || "model")));
        for (const { role, input } of editedRoles) {
          const names = new Set(input.value.split(/[,，、]/).map((name) => name.trim()).filter(Boolean));
          for (const name of names) result.people.push({ name, role });
        }
      }
      if (release.input.value !== (change.releaseDate || "")) result.releaseDate = release.input.value;
      if (pair && merge.input.checked) {
        result.mergeWorkIds = [pair.localWorkId, pair.sourceWorkId];
        for (const { field, value } of fieldChoices) result[field] = value();
      }
      return result;
    }
    return { card, included: included.input, editControls, body, updateMerge, requiresMerge: () => needsMerge };
  }

  function updateControls() {
    updateMode();
    previewButton.disabled = busy || !intakeAllowed || Boolean(manifestFile);
    nextButton.disabled = busy || Boolean(pendingCommit);
    for (const button of sourceCollections.querySelectorAll("button")) button.disabled = busy || Boolean(pendingCommit);
    for (const { included, editControls, updateMerge } of rows) {
      if (!included) continue;
      included.disabled = busy || Boolean(pendingCommit) || !plan?.canCommit;
      for (const input of editControls) input.disabled = included.disabled || !included.checked;
      updateMerge(included.disabled);
    }
    const selected = rows.some(({ included }) => included?.checked);
    const canSubmit = Boolean(plan?.canCommit && selected && !rows.some(({ requiresMerge }) => requiresMerge?.()));
    actions.hidden = !plan?.canCommit || !rows.some(({ included }) => included);
    confirmed.disabled = busy || !canSubmit;
    commitButton.disabled = busy || !canSubmit || !confirmed.checked;
    commitButton.textContent = pendingCommit ? "重试确认入库" : "确认入库";
  }

  function showPlan(data, request) {
    plan = data;
    previewRequest = request;
    pendingCommit = null;
    confirmed.checked = false;
    confirmForm.hidden = false;
    planTitle.hidden = false;
    const activeFacts = data.collection && sourceCollectionFacts(data.collection);
    activeSource.textContent = data.collection ? [
      `当前来源合集 ${data.collection.name}`, activeFacts && `来源标注 ${activeFacts}`
    ].filter(Boolean).join(" · ") : "";
    activeSource.hidden = !activeSource.textContent;
    showPlanMessages(warnings, data.warnings);
    sourceCollections.replaceChildren(...(data.sourceCollections || []).map(sourceDirectoryItem));
    sourceCollections.hidden = !sourceCollections.childElementCount;
    rows = (data.changes || []).map(previewRow);
    changes.replaceChildren(...rows.map(({ card }) => card));
    planTitle.textContent = rows.length ? "待确认" : sourceCollections.hidden ? "预览结果" : "来源合集";
    const { offset, ...firstPageRequest } = request;
    nextRequest = null;
    if (data.nextOffset != null) {
      nextRequest = { ...request, offset: data.nextOffset };
    } else if (data.nextPage) {
      nextRequest = { ...firstPageRequest, url: data.nextPage };
      if (data.sourceCollectionUrl) nextRequest.sourceCollectionUrl = data.sourceCollectionUrl;
    }
    next.hidden = !nextRequest;
    if (request.mode === "source") previewFields.url.value = request.url;
    setStatus(status, rows.length
      ? `已预览 ${rows.length} 条资料，请核对后选择入库。`
      : sourceCollections.querySelector("button") ? "请选择来源合集，继续预览单期。" : "本批没有可预览的资料。");
  }

  async function preview(request, fresh = false) {
    if (busy || !intakeAllowed || manifestFile) return;
    busy = true;
    updateControls();
    setStatus(status, "正在生成预览…");
    try {
      const data = await post("preview", request);
      if (fresh) receipt.hidden = true;
      showPlan(data, request);
    } catch (error) {
      setStatus(status, `生成预览失败。 ${error.message}${plan ? " 当前仍显示上一次预览。" : ""}`, true);
    } finally {
      busy = false;
      updateControls();
    }
  }

  function showReceipt(data) {
    receipt.hidden = false;
    setStatus(receiptStatus, `已入库 ${data.imported || 0} 条 · 已处理 ${data.replayed || 0} 条 · 失败 ${data.failed || 0} 条`, Boolean(data.failed));
    const titles = new Map((plan?.changes || []).map((change) => [change.key, change.title || change.issueCode]));
    receiptResults.replaceChildren(...(data.results || []).map((result) => {
      const row = node("li");
      const error = result.error || result.status === "failed" || result.ok === false;
      row.append(node("h3", "", result.title || result.work?.title || titles.get(result.key) || "入库记录"));
      row.append(node("p", error ? "error" : "details", error
        ? `失败 · ${messageText(result.error || result)}`
        : result.replayed || result.status === "replayed" ? "已处理，无需重复入库" : "已入库"));
      if (result.conflicts?.length) {
        const details = node("ul", "warnings");
        showPlanMessages(details, result.conflicts);
        row.append(details);
      }
      if (result.work?.archives?.length) {
        const links = node("ul", "link-list");
        appendArchiveLinks(links, result.work.archives);
        row.append(links);
      }
      return row;
    }));
  }

  async function commit() {
    if (busy || !plan?.planId || !plan.canCommit || !confirmed.checked || rows.some(({ requiresMerge }) => requiresMerge?.())) return;
    const selected = rows.filter(({ included }) => included?.checked).map(({ body }) => body());
    if (!selected.length) return;
    pendingCommit ||= { planId: plan.planId, confirmed: true, changes: selected };
    busy = true;
    updateControls();
    setStatus(status, "正在入库…");
    try {
      const data = await post("commit", pendingCommit);
      showReceipt(data);
      pendingCommit = null;
      plan = null;
      confirmed.checked = false;
      changes.replaceChildren();
      rows = [];
      warnings.hidden = true;
      sourceCollections.hidden = true;
      activeSource.hidden = true;
      planTitle.hidden = true;
      confirmForm.hidden = !nextRequest;
      if (data.imported || data.replayed) onSaved();
      setStatus(status, data.failed ? "本批处理完成。失败条目可检查原因后重新预览。" : "");
    } catch (error) {
      if (error.status >= 400 && error.status < 500) pendingCommit = null;
      if (error.status === 409) plan = null;
      confirmed.checked = false;
      setStatus(status, pendingCommit
        ? "暂未收到入库回执。可勾选确认后按原选择重试。"
        : `入库失败。 ${error.message}`, true);
    } finally {
      busy = false;
      updateControls();
    }
  }

  previewFields.mode.addEventListener("change", updateMode);
  previewFields.sourceLocalCollectionId.addEventListener("change", updateMode);
  previewFields.manifestFile.addEventListener("change", async () => {
    const file = previewFields.manifestFile.files[0];
    manifestFile = file;
    updateControls();
    if (!file) return;
    try {
      const content = await file.text();
      if (manifestFile === file) previewFields.manifest.value = content;
    } catch {
      if (manifestFile === file) setStatus(status, "读取清单文件失败。可以改为粘贴 JSON。", true);
    } finally {
      if (manifestFile === file) {
        manifestFile = null;
        updateControls();
      }
    }
  });
  previewForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      void preview(requestFromForm(), true);
    } catch (error) {
      setStatus(status, error.message, true);
    }
  });
  sampleButton.addEventListener("click", () => {
    previewFields.url.value = sampleSourceUrl;
    void preview(requestFromForm(), true);
  });
  confirmForm.addEventListener("change", (event) => {
    if (changes.contains(event.target)) confirmed.checked = false;
    updateControls();
  });
  confirmForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void commit();
  });
  nextButton.addEventListener("click", () => {
    if (nextRequest) void preview(nextRequest);
  });
  function openFromLink() {
    if (location.hash === "#intake") panel.open = true;
  }
  window.addEventListener("hashchange", openFromLink);
  document.querySelector('a[href="#intake"]').addEventListener("click", () => { panel.open = true; });
  panel.addEventListener("toggle", () => void loadOptions());
  if (localCollectionKey) {
    previewFields.mode.value = "local";
    panel.open = true;
  }
  openFromLink();
  updateControls();
}
