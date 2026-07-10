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
  return runtime;
}

function createModuleRegistry({ modules, sendJson }) {
  const byId = new Map(modules.map((entry) => [entry.definition.id, entry]));

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

  return Object.freeze({
    definitions: Object.freeze(modules.map((entry) => entry.definition)),
    get,
    publicManifest,
    routeApi,
    routeMedia,
    start,
    stop
  });
}
