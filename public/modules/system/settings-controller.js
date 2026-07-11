export function createSettingsController({ api, root, summary, status, onSaved }) {
  let modules = [];
  let activeModuleId = "";

  root?.addEventListener("click", handleClick);
  root?.addEventListener("submit", handleSubmit);

  async function load(options = {}) {
    if (!root) return false;
    if (!options.quiet) setStatus("正在读取模块设置");
    try {
      const data = await api("/api/admin/settings");
      modules = Array.isArray(data.modules) ? data.modules : [];
      if (!modules.some((module) => module.id === activeModuleId)) {
        activeModuleId = modules[0]?.id || "";
      }
      render();
      if (!options.quiet) setStatus("");
      return true;
    } catch (error) {
      modules = [];
      render(error.message || "模块设置读取失败");
      setStatus(error.message || "模块设置读取失败", "error");
      return false;
    }
  }

  function render(errorMessage = "") {
    if (!root) return;
    root.replaceChildren();
    const sectionCount = modules.reduce((total, module) => total + sectionsOf(module).length, 0);
    if (summary) {
      summary.textContent = errorMessage
        ? "设置注册表暂不可用"
        : `${modules.length} 个模块 · ${sectionCount} 组设置`;
    }
    if (!modules.length) {
      root.append(emptyState(errorMessage || "当前没有模块声明可配置项"));
      return;
    }

    const navigation = document.createElement("nav");
    navigation.className = "admin-settings-modules";
    navigation.setAttribute("aria-label", "设置模块");
    modules.forEach((module, index) => navigation.append(createModuleButton(module, index)));

    const content = document.createElement("div");
    content.className = "admin-settings-content";
    const activeModule = modules.find((module) => module.id === activeModuleId) || modules[0];
    content.append(createModulePanel(activeModule));
    root.append(navigation, content);
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
    const value = module.values?.[key];
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
    button.dataset.settingsAction = action.id;
    button.dataset.settingsModule = module.id;
    button.dataset.settingsSection = section.id;
    return button;
  }

  async function handleSubmit(event) {
    const form = event.target.closest("form[data-settings-module][data-settings-section]");
    if (!form) return;
    event.preventDefault();
    const module = modules.find((item) => item.id === form.dataset.settingsModule);
    const section = sectionsOf(module).find((item) => item.id === form.dataset.settingsSection);
    if (!module || !section) return;
    const button = form.querySelector('button[type="submit"]');
    const sectionStatus = form.querySelector("[data-settings-section-status]");
    setBusy(button, true, "保存中");
    setNodeStatus(sectionStatus, "正在保存此分组");
    try {
      const values = valuesFromForm(form, section);
      if (!Object.keys(values).length) {
        setNodeStatus(sectionStatus, "没有填写需要保存的新内容");
        return;
      }
      const data = await api(`/api/admin/settings/${encodeURIComponent(module.id)}`, {
        method: "PATCH",
        body: { values }
      });
      replaceModule(data.module);
      render();
      setStatus(`${module.title || module.id} · ${section.title || section.id} 已保存`, "success");
      await onSaved?.(data.module || module);
    } catch (error) {
      setNodeStatus(sectionStatus, error.message || "保存失败", "error");
      setStatus(error.message || "保存失败", "error");
    } finally {
      setBusy(button, false);
    }
  }

  async function handleClick(event) {
    const moduleButton = event.target.closest("[data-settings-module]:not([data-settings-section])");
    if (moduleButton?.dataset.settingsModule && modules.some((module) => module.id === moduleButton.dataset.settingsModule)) {
      activeModuleId = moduleButton.dataset.settingsModule;
      render();
      return;
    }

    const actionButton = event.target.closest("button[data-settings-action]");
    if (!actionButton) return;
    const module = modules.find((item) => item.id === actionButton.dataset.settingsModule);
    const section = sectionsOf(module).find((item) => item.id === actionButton.dataset.settingsSection);
    const action = (section?.actions || []).find((item) => item.id === actionButton.dataset.settingsAction);
    if (!module || !section || !action) return;
    if (action.confirm && !window.confirm(action.confirm)) return;

    const form = actionButton.closest("form");
    const sectionStatus = form?.querySelector("[data-settings-section-status]");
    setBusy(actionButton, true, action.busyLabel || "执行中");
    setNodeStatus(sectionStatus, action.progressLabel || "正在执行模块操作");
    try {
      const data = await api(`/api/admin/settings/${encodeURIComponent(module.id)}/actions/${encodeURIComponent(action.id)}`, {
        method: "POST",
        body: {}
      });
      replaceModule(data.module);
      render();
      const result = data.action?.result || data.result || {};
      const resultMessage = result.message
        || (result.test?.ok ? `测试通过${result.test.title ? `：${result.test.title}` : ""}` : result.test?.error)
        || `${action.label || action.id} 已完成`;
      setStatus(resultMessage, result.ok === false ? "error" : "success");
      await onSaved?.(data.module || module);
    } catch (error) {
      setNodeStatus(sectionStatus, error.message || "操作失败", "error");
      setStatus(error.message || "操作失败", "error");
    } finally {
      setBusy(actionButton, false);
    }
  }

  function valuesFromForm(form, section) {
    const values = {};
    for (const field of Array.isArray(section.fields) ? section.fields : []) {
      if (field.readOnly) continue;
      const key = fieldKey(field);
      const control = [...form.querySelectorAll("[data-setting-key]")].find((node) => node.dataset.settingKey === key);
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

  function replaceModule(nextModule) {
    if (!nextModule?.id) return;
    const index = modules.findIndex((module) => module.id === nextModule.id);
    if (index >= 0) modules[index] = nextModule;
  }

  function setStatus(message, tone = "") {
    setNodeStatus(status, message, tone);
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

function setBusy(button, busy, busyText) {
  if (!button) return;
  button.dataset.originalText ||= button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.originalText;
}

function setNodeStatus(node, message, tone = "") {
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("error", tone === "error");
  node.classList.toggle("success", tone === "success");
}

function emptyState(message) {
  const node = document.createElement("div");
  node.className = "admin-empty admin-settings-empty";
  node.textContent = message;
  return node;
}
