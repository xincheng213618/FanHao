import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MODULE_ENTRY_FILE = "module.js";

export async function discoverFanHaoModules({ modulesDir, context, sendJson }) {
  const discovered = await loadModuleEntries(modulesDir);
  const modules = [];
  for (const entry of discovered) {
    const runtime = entry.createModule
      ? await entry.createModule({ ...context, definition: entry.definition })
      : {};
    modules.push({ definition: entry.definition, runtime: normalizeRuntime(runtime, entry.definition.id) });
  }

  modules.sort((a, b) => a.definition.order - b.definition.order || a.definition.id.localeCompare(b.definition.id, "en"));
  return createModuleRegistry({ modules, sendJson });
}

export async function discoverFanHaoModuleDefinitions({ modulesDir }) {
  const entries = await loadModuleEntries(modulesDir);
  return Object.freeze(entries.map((entry) => entry.definition));
}

async function loadModuleEntries(modulesDir) {
  const entries = fs.readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  const modules = [];
  const ids = new Set();

  for (const entry of entries) {
    const entryPath = path.join(modulesDir, entry.name, MODULE_ENTRY_FILE);
    if (!fs.statSync(entryPath, { throwIfNoEntry: false })?.isFile()) continue;

    const namespace = await import(pathToFileURL(entryPath).href);
    const definition = normalizeDefinition(namespace.moduleDefinition, entry.name);
    if (ids.has(definition.id)) throw new Error(`Duplicate FanHao module id: ${definition.id}`);
    ids.add(definition.id);

    modules.push({ definition, createModule: namespace.createModule });
  }

  modules.sort((a, b) => a.definition.order - b.definition.order || a.definition.id.localeCompare(b.definition.id, "en"));
  return modules;
}

function normalizeDefinition(value, folderName) {
  if (!value || typeof value !== "object") throw new Error(`Missing moduleDefinition in ${folderName}/${MODULE_ENTRY_FILE}`);
  const id = String(value.id || "").trim();
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`Invalid FanHao module id: ${id || folderName}`);
  if (id !== folderName) throw new Error(`FanHao module folder '${folderName}' must match id '${id}'`);
  const title = String(value.title || "").trim();
  if (!title) throw new Error(`Missing title for FanHao module: ${id}`);
  const order = Number(value.order ?? 100);
  if (!Number.isFinite(order)) throw new Error(`Invalid order for FanHao module: ${id}`);

  return Object.freeze({
    id,
    title,
    description: String(value.description || "").trim(),
    order,
    visible: value.visible !== false,
    client: normalizeClient(value.client),
    capabilities: [...new Set((Array.isArray(value.capabilities) ? value.capabilities : []).map(String).filter(Boolean))]
  });
}

function normalizeClient(value) {
  const client = value && typeof value === "object" ? value : {};
  return {
    web: normalizeClientSurface(client.web),
    android: normalizeClientSurface(client.android)
  };
}

function normalizeClientSurface(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined || raw === "") continue;
    result[key] = typeof raw === "string" ? raw : raw;
  }
  return Object.keys(result).length ? Object.freeze(result) : null;
}

function normalizeRuntime(value, id) {
  const runtime = value && typeof value === "object" ? value : {};
  for (const method of ["routeApi", "routeMedia", "start", "stop", "invalidate"]) {
    if (runtime[method] !== undefined && typeof runtime[method] !== "function") {
      throw new Error(`FanHao module '${id}' has invalid ${method}`);
    }
  }
  const settings = normalizeSettingsProvider(runtime.settings, id);
  return settings ? { ...runtime, settings } : runtime;
}

function normalizeSettingsProvider(value, moduleId) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`FanHao module '${moduleId}' has invalid settings provider`);
  }
  if (typeof value.read !== "function") {
    throw new Error(`FanHao module '${moduleId}' settings provider must implement read()`);
  }
  for (const method of ["update", "action"]) {
    if (value[method] !== undefined && typeof value[method] !== "function") {
      throw new Error(`FanHao module '${moduleId}' has invalid settings.${method}`);
    }
  }

  const schema = normalizeSettingsSchema(value.schema, moduleId);
  const actionCount = schema.sections.reduce((total, section) => total + section.actions.length, 0);
  if (actionCount && typeof value.action !== "function") {
    throw new Error(`FanHao module '${moduleId}' declares settings actions without action()`);
  }

  return Object.freeze({
    schema,
    read: value.read,
    update: value.update,
    action: value.action
  });
}

function normalizeSettingsSchema(value, moduleId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`FanHao module '${moduleId}' settings provider is missing schema`);
  }
  if (!Array.isArray(value.sections) || !value.sections.length) {
    throw new Error(`FanHao module '${moduleId}' settings schema must declare sections`);
  }

  const sectionIds = new Set();
  const fieldKeys = new Set();
  const actionIds = new Set();
  const sections = value.sections.map((section, index) => {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      throw new Error(`FanHao module '${moduleId}' has invalid settings section`);
    }
    const id = String(section.id || "").trim();
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new Error(`FanHao module '${moduleId}' has invalid settings section id: ${id || index}`);
    }
    if (sectionIds.has(id)) throw new Error(`FanHao module '${moduleId}' has duplicate settings section: ${id}`);
    sectionIds.add(id);
    const title = String(section.title || "").trim();
    if (!title) throw new Error(`FanHao module '${moduleId}' settings section '${id}' is missing title`);

    const fields = (Array.isArray(section.fields) ? section.fields : []).map((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        throw new Error(`FanHao module '${moduleId}' settings section '${id}' has invalid field`);
      }
      const key = String(field.key || "").trim();
      if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) {
        throw new Error(`FanHao module '${moduleId}' has invalid settings field key: ${key || id}`);
      }
      if (fieldKeys.has(key)) throw new Error(`FanHao module '${moduleId}' has duplicate settings field: ${key}`);
      fieldKeys.add(key);
      const type = String(field.type || "").trim();
      const label = String(field.label || "").trim();
      if (!type || !label) throw new Error(`FanHao module '${moduleId}' settings field '${key}' is missing type or label`);
      return Object.freeze({ ...field, key, type, label, writeOnly: field.writeOnly === true });
    });

    const actions = (Array.isArray(section.actions) ? section.actions : []).map((action) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) {
        throw new Error(`FanHao module '${moduleId}' settings section '${id}' has invalid action`);
      }
      const actionId = String(action.id || "").trim();
      if (!/^[a-z][a-z0-9-]*$/.test(actionId)) {
        throw new Error(`FanHao module '${moduleId}' has invalid settings action id: ${actionId || id}`);
      }
      if (actionIds.has(actionId)) throw new Error(`FanHao module '${moduleId}' has duplicate settings action: ${actionId}`);
      actionIds.add(actionId);
      const label = String(action.label || "").trim();
      if (!label) throw new Error(`FanHao module '${moduleId}' settings action '${actionId}' is missing label`);
      return Object.freeze({ ...action, id: actionId, label });
    });

    if (!fields.length && !actions.length) {
      throw new Error(`FanHao module '${moduleId}' settings section '${id}' is empty`);
    }
    const order = Number(section.order ?? index * 10);
    if (!Number.isFinite(order)) throw new Error(`FanHao module '${moduleId}' settings section '${id}' has invalid order`);
    return Object.freeze({ ...section, id, title, order, fields: Object.freeze(fields), actions: Object.freeze(actions) });
  });

  sections.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id, "en"));
  return Object.freeze({ ...value, sections: Object.freeze(sections) });
}

function createModuleRegistry({ modules, sendJson }) {
  const byId = new Map(modules.map((entry) => [entry.definition.id, entry]));
  const settingsEntries = modules.filter((entry) => entry.runtime.settings);

  async function routeApi(req, res, url) {
    if (url.pathname === "/api/modules" && req.method === "GET") {
      sendJson(res, 200, { modules: publicManifest() });
      return true;
    }
    for (const entry of modules) {
      if (await entry.runtime.routeApi?.(req, res, url)) return true;
    }
    return false;
  }

  async function routeMedia(req, res, url) {
    for (const entry of modules) {
      if (await entry.runtime.routeMedia?.(req, res, url)) return true;
    }
    return false;
  }

  async function start() {
    for (const entry of modules) await entry.runtime.start?.();
  }

  async function stop() {
    for (const entry of [...modules].reverse()) await entry.runtime.stop?.();
  }

  function publicManifest() {
    return modules
      .filter((entry) => entry.definition.visible)
      .map((entry) => ({
        id: entry.definition.id,
        title: entry.definition.title,
        description: entry.definition.description,
        order: entry.definition.order,
        client: entry.definition.client,
        capabilities: entry.definition.capabilities
      }));
  }

  function get(id) {
    return byId.get(String(id || ""))?.runtime || null;
  }

  async function settingsCatalog() {
    const catalog = [];
    for (const entry of settingsEntries) catalog.push(await settingsSnapshot(entry));
    return catalog;
  }

  async function updateSettings(moduleId, values = {}) {
    const entry = settingsEntry(moduleId);
    if (typeof entry.runtime.settings.update !== "function") {
      throw moduleSettingsError(`模块 '${entry.definition.id}' 的设置为只读`, 405);
    }
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw moduleSettingsError("设置内容必须是对象", 400);
    }
    const allowedKeys = settingsFieldKeys(entry.runtime.settings.schema);
    const unknownKey = Object.keys(values).find((key) => !allowedKeys.has(key));
    if (unknownKey) throw moduleSettingsError(`未知的设置字段：${unknownKey}`, 400);
    await entry.runtime.settings.update(values);
    return settingsSnapshot(entry);
  }

  async function runSettingsAction(moduleId, actionId, payload = {}) {
    const entry = settingsEntry(moduleId);
    const normalizedActionId = String(actionId || "").trim();
    const allowedActions = settingsActionIds(entry.runtime.settings.schema);
    if (!allowedActions.has(normalizedActionId)) {
      throw moduleSettingsError(`未知的模块设置操作：${normalizedActionId || actionId}`, 404);
    }
    const result = await entry.runtime.settings.action(normalizedActionId, payload);
    return {
      module: await settingsSnapshot(entry),
      result: result && typeof result === "object" ? result : { value: result }
    };
  }

  function settingsEntry(moduleId) {
    const id = String(moduleId || "").trim();
    const entry = byId.get(id);
    if (!entry?.runtime.settings) throw moduleSettingsError(`模块 '${id || moduleId}' 没有可用设置`, 404);
    return entry;
  }

  return Object.freeze({
    definitions: Object.freeze(modules.map((entry) => entry.definition)),
    get,
    publicManifest,
    runSettingsAction,
    routeApi,
    routeMedia,
    settingsCatalog,
    start,
    stop,
    updateSettings
  });
}

async function settingsSnapshot(entry) {
  const provider = entry.runtime.settings;
  const raw = await provider.read();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw moduleSettingsError(`模块 '${entry.definition.id}' 的设置读取结果无效`, 500);
  }
  const rawValues = raw.values && typeof raw.values === "object" && !Array.isArray(raw.values)
    ? raw.values
    : {};
  const values = Object.fromEntries(
    [...settingsFieldKeys(provider.schema)]
      .filter((key) => Object.hasOwn(rawValues, key))
      .map((key) => [key, rawValues[key]])
  );
  for (const key of writeOnlySettingsFieldKeys(provider.schema)) delete values[key];
  const status = raw.status && typeof raw.status === "object" && !Array.isArray(raw.status)
    ? raw.status
    : { fields: {} };

  return {
    id: entry.definition.id,
    title: entry.definition.title,
    description: entry.definition.description,
    order: entry.definition.order,
    schema: provider.schema,
    values,
    status
  };
}

function settingsFieldKeys(schema) {
  return new Set(schema.sections.flatMap((section) => section.fields.map((field) => field.key)));
}

function writeOnlySettingsFieldKeys(schema) {
  return new Set(schema.sections.flatMap((section) => section.fields.filter((field) => field.writeOnly).map((field) => field.key)));
}

function settingsActionIds(schema) {
  return new Set(schema.sections.flatMap((section) => section.actions.map((action) => action.id)));
}

function moduleSettingsError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
