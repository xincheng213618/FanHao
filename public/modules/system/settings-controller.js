export function createSettingsController({ api, root, summary, status, onSaved, isActive = () => true }) {
  let modules = [];
  let activeModuleId = "";
  let navigation = null;
  let content = null;
  let readOwner = null;
  let writeVersion = 0;
  let statusOwner = null;
  let catalogError = "";
  let messageState = { message: "", tone: "" };
  const views = new Map();
  const fields = new WeakMap();
  const mutations = new Set();

  root?.addEventListener("click", handleClick);
  root?.addEventListener("submit", handleSubmit);
  for (const type of ["input", "change", "compositionstart", "compositionend"]) {
    root?.addEventListener(type, event => {
      const binding = fields.get(event.target);
      if (!binding) return;
      binding.revision++;
      if (type === "compositionstart") binding.composing = true;
      if (type === "compositionend") binding.composing = false;
    });
  }

  async function load(options = {}) {
    if (!root) return false;
    readOwner?.controller?.abort();
    const request = { controller: null };
    readOwner = request;
    statusOwner = request;
    root.setAttribute("aria-busy", "true");
    if (!options.quiet) setStatus("正在读取模块设置");
    try {
      while (readOwner === request) {
        while (mutations.size) {
          await Promise.all([...mutations].map(operation => operation.done));
          if (readOwner !== request) return false;
        }
        if (readOwner !== request) return false;
        const version = writeVersion;
        request.controller = new AbortController();
        request.readFields = captureReadFields(root);
        let data;
        try { data = await api("/api/admin/settings", { signal: request.controller.signal }); }
        catch (error) {
          if (readOwner !== request) return false;
          if (version !== writeVersion || mutations.size) continue;
          throw error;
        }
        if (readOwner !== request) return false;
        // A catalog captured before a write cannot undo its confirmed receipt.
        if (version !== writeVersion || mutations.size) continue;
        modules = Array.isArray(data.modules) ? data.modules : [];
        if (!modules.some(module => module.id === activeModuleId)) activeModuleId = modules[0]?.id || "";
        render("", request);
        if (statusOwner === request) setStatus("");
        return true;
      }
      return false;
    } catch (error) {
      if (readOwner !== request) return false;
      render(error.message || "模块设置读取失败");
      if (statusOwner === request) setStatus(error.message || "模块设置读取失败", "error");
      return false;
    } finally {
      if (readOwner === request) { readOwner = null; root.removeAttribute("aria-busy"); }
    }
  }

  function render(errorMessage = catalogError, confirmation = null) {
    if (!root) return;
    catalogError = errorMessage;
    const sectionCount = modules.reduce((total, module) => total + sectionsOf(module).length, 0);
    if (summary && isActive()) {
      summary.textContent = errorMessage
        ? (modules.length ? "刷新失败，已保留当前设置和输入" : "设置注册表暂不可用")
        : `${modules.length} 个模块 · ${sectionCount} 组设置`;
    }
    if (!modules.length) {
      views.clear(); navigation = null; content = null;
      const empty = emptyState(errorMessage || (readOwner ? "正在读取模块设置" : "当前没有模块声明可配置项"));
      if (errorMessage) {
        const retry = document.createElement("button");
        retry.type = "button"; retry.className = "folder-button"; retry.textContent = "重试读取";
        retry.addEventListener("click", () => { if (root.contains(retry) && isActive() && !readOwner) void load(); });
        empty.append(retry);
      }
      root.replaceChildren(empty);
      paintStatus();
      return;
    }
    if (navigation?.parentElement !== root || content?.parentElement !== root) {
      views.clear();
      navigation = document.createElement("nav");
      navigation.className = "admin-settings-modules";
      navigation.setAttribute("aria-label", "设置模块");
      content = document.createElement("div"); content.className = "admin-settings-content";
      root.replaceChildren(navigation, content);
    }
    for (const [index, module] of modules.entries()) {
      const nextButton = createModuleButton(module, index), nextPanel = createModulePanel(module);
      let view = views.get(module.id);
      if (!view) { view = { button: nextButton, panel: nextPanel }; views.set(module.id, view); }
      else {
        view.button.replaceChildren(...nextButton.childNodes);
        syncPanel(view.panel, nextPanel, confirmation);
      }
    }
    for (const id of views.keys()) if (!modules.some(module => module.id === id)) views.delete(id);
    reconcileChildren(navigation, modules.map(module => views.get(module.id).button));
    reconcileChildren(content, modules.map(module => views.get(module.id).panel));
    activateModule();
    paintMutations();
    paintStatus();
  }

  function activateModule() {
    for (const [id, view] of views) {
      const active = id === activeModuleId;
      view.button.classList.toggle("active", active);
      view.button.setAttribute("aria-pressed", String(active));
      view.panel.hidden = !active;
      view.panel.inert = !active;
    }
  }

  function syncPanel(panel, next, confirmation) {
    panel.querySelector(".admin-settings-module-head").replaceWith(next.querySelector(".admin-settings-module-head"));
    const forms = new Map([...panel.querySelectorAll("form")].map(form => [form.dataset.settingsSection, form]));
    const wanted = [panel.firstElementChild];
    for (const fresh of [...next.querySelectorAll("form")]) {
      const form = forms.get(fresh.dataset.settingsSection);
      if (!form) { wanted.push(fresh); continue; }
      form.querySelector(".admin-settings-section-head").replaceWith(fresh.querySelector(".admin-settings-section-head"));
      let grid = form.querySelector(".admin-settings-fields");
      const nextGrid = fresh.querySelector(".admin-settings-fields");
      if (nextGrid) {
        grid ||= document.createElement("div"); grid.className = nextGrid.className;
        const controls = new Map([...grid.querySelectorAll("[data-setting-key]")].map(control => [control.dataset.settingKey, control]));
        const wrappers = [];
        for (const wrapper of [...nextGrid.children]) {
          const expected = wrapper.querySelector("[data-setting-key]"), control = controls.get(expected.dataset.settingKey);
          if (!control || !sameControlKind(control, expected)) { wrappers.push(wrapper); continue; }
          const binding = fields.get(control), nextBinding = fields.get(expected), value = controlValue(control);
          const submitted = confirmation?.submitted?.get(control);
          const selection = controlSelection(control);
          const selectedLater = submitted && document.activeElement === control && selection && submitted.selection
            && (selection.start !== submitted.selection.start || selection.end !== submitted.selection.end || selection.direction !== submitted.selection.direction);
          const confirmed = submitted && submitted.revision === binding.revision && submitted.value === value && !selectedLater;
          const editedAfterSave = submitted && !confirmed;
          if (submitted && (editedAfterSave || binding.composing)) confirmation.laterEdits = true;
          const observed = confirmation?.readFields?.get(control);
          const editedAfterRead = observed && (observed.revision !== binding.revision || (document.activeElement === control && selection && observed.selection
            && (selection.start !== observed.selection.start || selection.end !== observed.selection.end || selection.direction !== observed.selection.direction)));
          const update = !binding.composing && !editedAfterSave && !editedAfterRead && (confirmed || value === binding.baseline || nextBinding.field.readOnly);
          syncControlAttributes(control, expected);
          if (control.tagName === "SELECT") reconcileOptions(control, expected);
          if (update || (control.tagName === "SELECT" && ![...control.options].some(option => option.value === value))) {
            assignControlValue(control, nextBinding.baseline);
          }
          binding.field = nextBinding.field; binding.baseline = nextBinding.baseline;
          const oldWrapper = control.parentElement;
          oldWrapper.className = wrapper.className;
          oldWrapper.querySelector(".admin-setting-field-title").replaceWith(wrapper.querySelector(".admin-setting-field-title"));
          const help = oldWrapper.querySelector(".admin-setting-help"), nextHelp = wrapper.querySelector(".admin-setting-help");
          if (help && nextHelp) help.replaceWith(nextHelp);
          else if (help) help.remove();
          else if (nextHelp) oldWrapper.append(nextHelp);
          wrappers.push(oldWrapper);
        }
        reconcileChildren(grid, wrappers);
      } else { grid?.remove(); grid = null; }
      let actions = form.querySelector(".admin-actions");
      const nextActions = fresh.querySelector(".admin-actions");
      if (nextActions) {
        actions ||= document.createElement("div"); actions.className = nextActions.className;
        const buttons = new Map([...actions.children].map(button => [button.dataset.settingsAction || "save", button]));
        const wantedButtons = [...nextActions.children].map(button => {
          const current = buttons.get(button.dataset.settingsAction || "save");
          if (!current) return button;
          current.className = button.className;
          current.dataset.settingsIdleLabel = button.dataset.settingsIdleLabel;
          return current;
        });
        reconcileChildren(actions, wantedButtons);
      } else { actions?.remove(); actions = null; }
      reconcileChildren(form, [form.firstElementChild, grid, actions, form.querySelector("[data-settings-section-status]")].filter(Boolean));
      wanted.push(form);
    }
    reconcileChildren(panel, wanted);
  }

  function createModuleButton(module, index) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `admin-settings-module${module.id === activeModuleId ? " active" : ""}`;
    button.dataset.settingsModule = module.id;
    button.setAttribute("aria-pressed", module.id === activeModuleId ? "true" : "false");

    const number = document.createElement("span");
    number.className = "admin-settings-module-index";
    number.textContent = String(index + 1).padStart(2, "0");
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = module.title || module.id;
    const detail = document.createElement("small");
    detail.textContent = `${sectionsOf(module).length} 组设置`;
    copy.append(title, detail);
    button.append(number, copy);
    return button;
  }

  function createModulePanel(module) {
    const panel = document.createElement("article");
    panel.className = "admin-settings-module-panel";
    panel.dataset.settingsModulePanel = module.id;

    const header = document.createElement("header");
    header.className = "admin-settings-module-head";
    const copy = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = `模块 · ${module.id}`;
    const title = document.createElement("h2");
    title.textContent = module.title || module.id;
    const description = document.createElement("p");
    description.textContent = module.description || "由模块提供的资料库设置。";
    copy.append(eyebrow, title, description);
    const badge = document.createElement("span");
    badge.className = "admin-badge";
    badge.textContent = `${sectionsOf(module).length} 组`;
    header.append(copy, badge);
    panel.append(header);

    for (const section of sectionsOf(module)) panel.append(createSectionForm(module, section));
    return panel;
  }

  function createSectionForm(module, section) {
    const form = document.createElement("form");
    form.className = "admin-settings-section";
    form.dataset.settingsModule = module.id;
    form.dataset.settingsSection = section.id;

    const header = document.createElement("div");
    header.className = "admin-settings-section-head";
    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = section.title || section.id;
    const description = document.createElement("p");
    description.textContent = section.description || "";
    copy.append(title);
    if (description.textContent) copy.append(description);
    header.append(copy);
    form.append(header);

    const fields = Array.isArray(section.fields) ? section.fields : [];
    if (fields.length) {
      const grid = document.createElement("div");
      grid.className = "admin-settings-fields";
      for (const field of fields) grid.append(createField(module, field));
      form.append(grid);
    }

    const actions = Array.isArray(section.actions) ? section.actions : [];
    if (fields.some((field) => !field.readOnly) || actions.length) {
      const actionRow = document.createElement("div");
      actionRow.className = "admin-actions";
      if (fields.some((field) => !field.readOnly)) {
        const save = document.createElement("button");
        save.type = "submit";
        save.className = "folder-button";
        save.textContent = section.saveLabel || "保存设置";
        save.dataset.settingsIdleLabel = save.textContent;
        actionRow.append(save);
      }
      for (const action of actions) actionRow.append(createActionButton(module, section, action));
      form.append(actionRow);
    }

    const sectionStatus = document.createElement("p");
    sectionStatus.className = "admin-status";
    sectionStatus.dataset.settingsSectionStatus = "";
    form.append(sectionStatus);
    return form;
  }

  function createField(module, field) {
    const key = fieldKey(field);
    const wrapper = document.createElement("label");
    wrapper.className = `admin-field admin-setting-field${field.type === "boolean" ? " toggle" : ""}`;

    const heading = document.createElement("span");
    heading.className = "admin-setting-field-title";
    const label = document.createElement("strong");
    label.textContent = field.label || key;
    heading.append(label);
    const fieldStatus = fieldStatusOf(module, key);
    if (fieldStatus) heading.append(createFieldBadge(fieldStatus));
    wrapper.append(heading);

    const control = createControl(module, field);
    control.dataset.settingKey = key;
    fields.set(control, { field, baseline: controlValue(control), revision: 0, composing: false });
    wrapper.append(control);

    const help = [field.help || field.description || "", statusSummary(fieldStatus)].filter(Boolean).join(" · ");
    if (help) {
      const note = document.createElement("small");
      note.className = "admin-setting-help";
      note.textContent = help;
      wrapper.append(note);
    }
    return wrapper;
  }

  function createControl(module, field) {
    const key = fieldKey(field);
    const value = field.writeOnly ? undefined : module.values?.[key];
    let control;
    if (["string-list", "secret"].includes(field.type) && Number(field.rows || 0) > 1) {
      control = document.createElement("textarea");
      control.rows = Number(field.rows) || (field.type === "string-list" ? 8 : 5);
      control.spellcheck = false;
      control.value = field.type === "string-list" && Array.isArray(value) ? value.join("\n") : "";
    } else if (field.type === "select") {
      control = document.createElement("select");
      for (const option of Array.isArray(field.options) ? field.options : []) {
        const node = document.createElement("option");
        node.value = String(option.value ?? option.id ?? "");
        node.textContent = String(option.label ?? option.value ?? option.id ?? "");
        control.append(node);
      }
      control.value = String(value ?? "");
    } else {
      control = document.createElement("input");
      control.type = field.type === "boolean" ? "checkbox" : ["number", "bytes"].includes(field.type) ? "number" : field.type === "secret" ? "password" : "text";
      if (field.type === "boolean") {
        control.checked = Boolean(value);
      } else if (field.type === "bytes") {
        control.value = formatScaledValue(value, field.unit || "GB");
      } else {
        control.value = field.writeOnly ? "" : String(value ?? "");
      }
    }
    if (field.placeholder) control.placeholder = field.placeholder;
    if (field.min !== undefined) control.min = String(field.min);
    if (field.max !== undefined) control.max = String(field.max);
    if (field.step !== undefined) control.step = String(field.step);
    if (field.required) control.required = true;
    if (field.readOnly) control.disabled = true;
    if (field.writeOnly) control.autocomplete = "off";
    if (field.unit && field.type !== "bytes") control.dataset.settingUnit = field.unit;
    return control;
  }

  function createFieldBadge(fieldStatus) {
    const badge = document.createElement("em");
    const configured = fieldStatus.configured ?? fieldStatus.exists ?? false;
    const tone = String(fieldStatus.tone || (configured ? "success" : "muted"));
    badge.className = `admin-badge ${tone}`;
    badge.textContent = fieldStatus.label || fieldStatus.state || (configured ? "已配置" : "未配置");
    return badge;
  }

  function createActionButton(module, section, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `folder-button ${action.kind === "primary" ? "" : "subtle"}`.trim();
    button.textContent = action.label || action.id;
    button.dataset.settingsIdleLabel = button.textContent;
    button.dataset.settingsAction = action.id;
    button.dataset.settingsModule = module.id;
    button.dataset.settingsSection = section.id;
    return button;
  }

  async function handleSubmit(event) {
    const form = event.target.closest?.("form[data-settings-module][data-settings-section]");
    if (!form) return;
    event.preventDefault();
    if (!currentForm(form)) return;
    const module = modules.find((item) => item.id === form.dataset.settingsModule);
    const section = sectionsOf(module).find((item) => item.id === form.dataset.settingsSection);
    if (!module || !section || mutationBlocked(module.id, section, false)) return;
    const button = form.querySelector('button[type="submit"]');
    const values = valuesFromForm(form, section);
    if (!Object.keys(values).length) { setNodeStatus(form.querySelector("[data-settings-section-status]"), "没有填写需要保存的新内容"); return; }
    const request = beginMutation(module, section, form, button, "save", "保存中");
    for (const control of form.querySelectorAll("[data-setting-key]")) {
      if (Object.hasOwn(values, control.dataset.settingKey)) request.submitted.set(control, {
        value: controlValue(control), revision: fields.get(control).revision, selection: controlSelection(control)
      });
    }
    setNodeStatus(request.status, "正在保存此分组");
    try {
      const data = await api(`/api/admin/settings/${encodeURIComponent(module.id)}`, {
        method: "PATCH",
        body: { values }
      });
      acceptReceipt(data.module, request);
      const message = `${module.title || module.id} · ${section.title || section.id} ${request.laterEdits ? "已保存提交内容；保留了后续编辑" : "已保存"}`;
      finishMessage(request, message, "success");
      await notifySaved(data.module, request, message);
    } catch (error) {
      finishMessage(request, error.message || "保存失败", "error");
    } finally { endMutation(request); }
  }

  async function handleClick(event) {
    const moduleButton = event.target.closest?.("button[data-settings-module]:not([data-settings-section])");
    if (moduleButton && root.contains(moduleButton) && isActive()
        && views.get(moduleButton.dataset.settingsModule)?.button === moduleButton) {
      if (activeModuleId === moduleButton.dataset.settingsModule) return;
      activeModuleId = moduleButton.dataset.settingsModule;
      statusOwner = null; setStatus(""); activateModule();
      return;
    }

    const actionButton = event.target.closest?.("button[data-settings-action]");
    const form = actionButton?.closest("form");
    if (!actionButton || !currentForm(form)) return;
    const module = modules.find((item) => item.id === actionButton.dataset.settingsModule);
    const section = sectionsOf(module).find((item) => item.id === actionButton.dataset.settingsSection);
    const action = (section?.actions || []).find((item) => item.id === actionButton.dataset.settingsAction);
    if (!module || !section || !action || mutationBlocked(module.id, section, true)) return;
    if (action.confirm && !window.confirm(action.confirm)) return;

    const request = beginMutation(module, section, form, actionButton, "action", action.busyLabel || "执行中");
    setNodeStatus(request.status, action.progressLabel || "正在执行模块操作");
    try {
      const data = await api(`/api/admin/settings/${encodeURIComponent(module.id)}/actions/${encodeURIComponent(action.id)}`, {
        method: "POST",
        body: {}
      });
      acceptReceipt(data.module, request);
      const result = data.action?.result || data.result || {};
      const resultMessage = result.message
        || (result.test?.ok ? `测试通过${result.test.title ? `：${result.test.title}` : ""}` : result.test?.error)
        || `${action.label || action.id} 已完成`;
      finishMessage(request, resultMessage, result.ok === false || data.ok === false ? "error" : "success");
      await notifySaved(data.module, request, resultMessage);
    } catch (error) {
      finishMessage(request, error.message || "操作失败", "error");
    } finally { endMutation(request); }
  }

  function currentForm(form) {
    return Boolean(form && root.isConnected && root.contains(form) && isActive()
      && form.dataset.settingsModule === activeModuleId
      && views.get(activeModuleId)?.panel.contains(form) && !views.get(activeModuleId).panel.hidden);
  }

  function captureReadFields(scope) {
    return new Map([...scope.querySelectorAll("[data-setting-key]")].filter(control => fields.has(control))
      .map(control => [control, { revision: fields.get(control).revision, selection: controlSelection(control) }]));
  }

  function mutationBlocked(moduleId, section, action) {
    const keys = new Set((section.fields || []).map(fieldKey));
    return [...mutations].some(request => request.module.id === moduleId && (action || request.kind === "action"
      || request.section.id === section.id || [...request.keys].some(key => keys.has(key))));
  }

  function beginMutation(module, section, form, button, kind, busyLabel) {
    let resolve;
    const request = { module, section, form, button, kind, busyLabel, submitted: new Map(),
      keys: new Set((section.fields || []).map(fieldKey)), status: form.querySelector("[data-settings-section-status]"),
      done: new Promise(done => { resolve = done; }), resolve: () => resolve() };
    if (kind === "action") request.readFields = captureReadFields(views.get(module.id).panel);
    mutations.add(request); writeVersion++;
    statusOwner = request;
    setStatus(`${module.title || module.id} · ${section.title || section.id} ${kind === "save" ? "正在保存" : "正在执行"}`);
    paintMutations();
    return request;
  }

  function endMutation(request) {
    mutations.delete(request); request.submitted.clear(); request.resolve(); paintMutations();
  }

  function paintMutations() {
    for (const module of modules) {
      const panel = views.get(module.id)?.panel;
      if (!panel) continue;
      for (const form of panel.querySelectorAll("form")) {
        const section = sectionsOf(module).find(item => item.id === form.dataset.settingsSection);
        if (!section) continue;
        const pending = [...mutations].find(request => request.form === form);
        if (pending) form.setAttribute("aria-busy", "true"); else form.removeAttribute("aria-busy");
        for (const button of form.querySelectorAll(".admin-actions button")) {
          const busy = pending?.button === button;
          button.setAttribute("aria-disabled", String(mutationBlocked(module.id, section, Boolean(button.dataset.settingsAction))));
          if (busy) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
          button.textContent = busy ? pending.busyLabel : button.dataset.settingsIdleLabel;
        }
      }
    }
  }

  function acceptReceipt(nextModule, request) {
    if (nextModule?.id !== request.module.id) throw new Error("设置回执不匹配，请刷新确认保存结果");
    const index = modules.findIndex(module => module.id === nextModule.id);
    if (index < 0 || !mutations.has(request)) return;
    if (request.kind === "action") modules[index] = nextModule;
    else {
      const current = modules[index], values = { ...current.values }, fieldStatus = { ...current.status?.fields };
      const status = { ...current.status, fields: fieldStatus };
      for (const key of request.keys) {
        if (Object.hasOwn(nextModule.values || {}, key)) values[key] = nextModule.values[key]; else delete values[key];
        const nextStatus = fieldStatusOf(nextModule, key);
        if (nextStatus) fieldStatus[key] = nextStatus; else delete fieldStatus[key];
        delete status[key];
      }
      modules[index] = { ...current, values, status };
    }
    render("", request);
  }

  function finishMessage(request, message, tone) {
    if (root.contains(request.form)) setNodeStatus(request.status, message, tone);
    if (statusOwner === request && activeModuleId === request.module.id) setStatus(message, tone);
  }

  async function notifySaved(module, request, message) {
    try { await onSaved?.(module); }
    catch (error) { finishMessage(request, `${message}；关联状态刷新失败：${error.message || "未知错误"}`, "error"); }
  }

  function valuesFromForm(form, section) {
    const values = {};
    const controls = new Map([...form.querySelectorAll("[data-setting-key]")].map(control => [control.dataset.settingKey, control]));
    for (const field of Array.isArray(section.fields) ? section.fields : []) {
      if (field.readOnly) continue;
      const key = fieldKey(field);
      const control = controls.get(key);
      if (!control) continue;
      if (field.writeOnly && !String(control.value || "").trim()) continue;
      if (field.type === "boolean") values[key] = Boolean(control.checked);
      else if (field.type === "string-list") values[key] = uniqueLines(control.value);
      else if (field.type === "number") values[key] = Number(control.value || 0);
      else if (field.type === "bytes") values[key] = Number(control.value || 0) * unitScale(field.unit || "GB");
      else values[key] = String(control.value || "").trim();
    }
    return values;
  }

  function setStatus(message, tone = "") {
    messageState = { message, tone };
    paintStatus();
  }

  function paintStatus() {
    if (root?.isConnected && isActive()) setNodeStatus(status, messageState.message, messageState.tone);
  }

  return Object.freeze({ load, render });
}

function sectionsOf(module) {
  return Array.isArray(module?.schema?.sections) ? module.schema.sections : [];
}

function fieldKey(field) {
  return String(field?.key || field?.id || "");
}

function fieldStatusOf(module, key) {
  return module?.status?.fields?.[key] || module?.status?.[key] || null;
}

function statusSummary(fieldStatus) {
  if (!fieldStatus) return "";
  const parts = [fieldStatus.summary || fieldStatus.message || ""];
  if (fieldStatus.updatedAt) parts.push(`更新 ${formatDateTime(fieldStatus.updatedAt)}`);
  if (fieldStatus.bytes) parts.push(formatBytes(fieldStatus.bytes));
  const items = fieldStatus.items || fieldStatus.cookieNames;
  if (Array.isArray(items) && items.length) parts.push(items.join(" / "));
  return parts.filter(Boolean).join(" · ");
}

function uniqueLines(value) {
  return [...new Set(String(value || "").split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean))];
}

function unitScale(unit) {
  return {
    B: 1,
    KB: 1024,
    KIB: 1024,
    MB: 1024 ** 2,
    MIB: 1024 ** 2,
    GB: 1024 ** 3,
    GIB: 1024 ** 3,
    TB: 1024 ** 4,
    TIB: 1024 ** 4
  }[String(unit || "").toUpperCase()] || 1;
}

function formatScaledValue(value, unit) {
  const scaled = Number(value || 0) / unitScale(unit);
  return Number.isFinite(scaled) ? String(Number(scaled.toFixed(3))) : "0";
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "") : date.toLocaleString("zh-CN", { hour12: false });
}

function controlValue(control) {
  return control.type === "checkbox" ? control.checked : control.value;
}

function assignControlValue(control, value) {
  if (controlValue(control) === value) return;
  const selection = document.activeElement === control ? controlSelection(control) : null;
  if (control.type === "checkbox") control.checked = value;
  else control.value = value;
  if (selection) control.setSelectionRange(selection.start, selection.end, selection.direction);
}

function controlSelection(control) {
  return Number.isFinite(control.selectionStart) && Number.isFinite(control.selectionEnd)
    ? { start: control.selectionStart, end: control.selectionEnd,
      direction: control.selectionStart === control.selectionEnd ? "none" : control.selectionDirection || "none" } : null;
}

function sameControlKind(control, expected) {
  return control.tagName === expected.tagName && (control.tagName !== "INPUT" || control.type === expected.type);
}

function syncControlAttributes(control, expected) {
  for (const key of ["type", "rows", "spellcheck", "placeholder", "min", "max", "step", "required", "disabled", "autocomplete", "data-setting-unit"]) {
    const value = expected.getAttribute(key);
    if (value === null) control.removeAttribute(key);
    else if (control.getAttribute(key) !== value) control.setAttribute(key, value);
  }
}

function reconcileOptions(control, expected) {
  if (control.options.length === expected.options.length && [...control.options].every((option, index) => option.value === expected.options[index].value)) {
    [...control.options].forEach((option, index) => { if (option.textContent !== expected.options[index].textContent) option.textContent = expected.options[index].textContent; });
    return;
  }
  const value = control.value, fallback = expected.value;
  control.replaceChildren(...expected.options);
  control.value = [...control.options].some(option => option.value === value) ? value : fallback;
}

function reconcileChildren(parent, wanted) {
  wanted.forEach((node, index) => { if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null); });
  for (const child of [...parent.children]) if (!wanted.includes(child)) child.remove();
}

function setNodeStatus(node, message, tone = "") {
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("error", tone === "error");
  node.classList.toggle("success", tone === "success");
  node.setAttribute("role", tone === "error" ? "alert" : "status");
}

function emptyState(message) {
  const node = document.createElement("div");
  node.className = "admin-empty admin-settings-empty";
  node.textContent = message;
  return node;
}
