const ENTRY_ROOT = "./modules/";
const FALLBACK_MODULES = Object.freeze([
  fallback("fanhao", "番号", 10, "works", "fanhao"),
  fallback("photos", "图库", 20, "channel", "photo", { channel: "photo" }),
  fallback("media", "影视", 30, "channel", "media", { channel: "media" }),
  fallback("novels", "小说", 40, "novels", "novels"),
  fallback("short-videos", "短视频", 50, "shortVideos", "shortVideos"),
  fallback("music", "音乐", 60, "music", "music"),
  fallback("tools", "小工具", 70, "tools", "tools", { title: "我的" })
]);

export function androidModuleFallbackCatalog() {
  return FALLBACK_MODULES.map((module) => ({ ...module, client: { android: { ...module.client.android } } }));
}

export function mergeAndroidModuleCatalog(remoteModules = []) {
  const remoteById = new Map((Array.isArray(remoteModules) ? remoteModules : []).map((module) => [module?.id, module]));
  const merged = androidModuleFallbackCatalog().map((fallbackModule) => {
    const remote = remoteById.get(fallbackModule.id) || {};
    return {
      ...fallbackModule,
      ...remote,
      client: {
        ...fallbackModule.client,
        ...(remote.client || {}),
        android: {
          ...fallbackModule.client.android,
          ...(remote.client?.android || {})
        }
      }
    };
  });
  const knownIds = new Set(merged.map((module) => module.id));
  for (const remote of Array.isArray(remoteModules) ? remoteModules : []) {
    if (!remote?.id || knownIds.has(remote.id) || !remote.client?.android?.entry) continue;
    merged.push(remote);
  }
  return merged.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

export async function loadAndroidModules(definitions, host) {
  const modules = [];
  for (const definition of definitions) {
    const surface = definition?.client?.android;
    if (!surface?.entry) continue;
    try {
      const entryUrl = androidEntryUrl(surface.entry, host.clientVersion);
      const namespace = await import(entryUrl);
      if (typeof namespace.createAndroidModule !== "function") {
        throw new Error(`Android module '${definition.id}' does not export createAndroidModule()`);
      }
      const instance = await namespace.createAndroidModule({ definition, host });
      modules.push(normalizeModule(instance, definition));
    } catch (error) {
      host.onModuleError?.(definition, error);
      console.error(`[android-module:${definition.id}]`, error);
    }
  }
  return createRegistry(modules);
}

function androidEntryUrl(entry, clientVersion) {
  const value = String(entry || "").trim().replaceAll("\\", "/");
  if (!value.startsWith(ENTRY_ROOT) || value.includes("..")) {
    throw new Error(`Invalid Android module entry: ${value || "(empty)"}`);
  }
  const url = new URL(value, document.baseURI);
  if (clientVersion) url.searchParams.set("client", String(clientVersion));
  return url.href;
}

function fallback(id, title, order, view, bottomKey, extra = {}) {
  return Object.freeze({
    id,
    title,
    order,
    client: Object.freeze({
      android: Object.freeze({
        view,
        bottomKey,
        entry: `./modules/${id}/android-module.js`,
        ...extra
      })
    })
  });
}

function normalizeModule(value, definition) {
  if (!value || typeof value !== "object") throw new Error(`Android module '${definition.id}' returned no module contract`);
  const routes = Array.isArray(value.routes) ? value.routes.map((route) => normalizeRoute(route, definition.id)) : [];
  if (!routes.length) throw new Error(`Android module '${definition.id}' registered no routes`);
  const rootViews = new Set((Array.isArray(value.rootViews) ? value.rootViews : []).map(String));
  return Object.freeze({
    id: definition.id,
    definition,
    routes: Object.freeze(routes),
    rootViews,
    bottomKey: String(value.bottomKey || definition.client?.android?.bottomKey || definition.id),
    search: value.search && typeof value.search === "object" ? value.search : null,
    deactivate: typeof value.deactivate === "function" ? value.deactivate : null,
    handleBack: typeof value.handleBack === "function" ? value.handleBack : null,
    api: value.api && typeof value.api === "object" ? value.api : Object.freeze({})
  });
}

function normalizeRoute(value, moduleId) {
  if (!value || typeof value !== "object") throw new Error(`Android module '${moduleId}' has an invalid route`);
  const view = String(value.view || "").trim();
  if (!view) throw new Error(`Android module '${moduleId}' has a route without a view`);
  if (typeof value.render !== "function") throw new Error(`Android module '${moduleId}' route '${view}' has no render()`);
  return Object.freeze({
    view,
    match: typeof value.match === "function" ? value.match : null,
    render: value.render
  });
}

function createRegistry(modules) {
  const byId = new Map(modules.map((module) => [module.id, module]));

  function resolve(view, params = {}) {
    const name = String(view || "");
    for (const module of modules) {
      for (const route of module.routes) {
        if (route.view !== name) continue;
        if (!route.match || route.match(params)) return { module, route };
      }
    }
    return null;
  }

  function render(view, params, renderGuard) {
    const resolved = resolve(view, params);
    return resolved?.route.render(params || {}, renderGuard);
  }

  function searchFor(view, params = {}) {
    const module = resolve(view, params)?.module || null;
    if (!module?.search) return null;
    if (typeof module.search.matches === "function" && !module.search.matches(view, params)) return null;
    return module.search;
  }

  function deactivateExcept(view, params = {}) {
    const activeId = resolve(view, params)?.module.id || "";
    for (const module of modules) {
      if (module.id !== activeId) module.deactivate?.();
    }
  }

  function handleBack(view, params = {}) {
    return Boolean(resolve(view, params)?.module.handleBack?.(view, params));
  }

  return Object.freeze({
    modules: Object.freeze([...modules]),
    get: (id) => byId.get(String(id || "")) || null,
    resolve,
    render,
    searchFor,
    deactivateExcept,
    handleBack
  });
}
