// Classic bootstrap deliberately runs before the unchanged real app module.
// These shims isolate browser persistence, not app navigation/rendering logic.
(() => {
  "use strict";
  const scriptUrl = new URL(document.currentScript.src);
  const runId = scriptUrl.searchParams.get("run");
  if (!runId) {
    document.querySelector("#startRun").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      const status = document.querySelector("#status");
      try {
        const response = await fetch("/fixture/new-run", { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "无法创建运行");
        const target = new URL(result.url, location.origin);
        if (target.origin !== location.origin) throw new Error("非隔离目标已拒绝");
        location.assign(target.href);
      } catch (error) {
        status.textContent = error.message;
        event.currentTarget.disabled = false;
      }
    });
    return;
  }
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid fixture run ID");
  const prefix = `gallery-navigation-fixture:${runId}:`;
  const storageKeys = (storage) => Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key) => key?.startsWith(prefix));
  for (const name of ["localStorage", "sessionStorage"]) {
    const original = window[name];
    const facade = Object.freeze({
      get length() { return storageKeys(original).length; },
      key(index) { return storageKeys(original)[index]?.slice(prefix.length) ?? null; },
      getItem(key) { return original.getItem(prefix + String(key)); },
      setItem(key, value) { original.setItem(prefix + String(key), String(value)); },
      removeItem(key) { original.removeItem(prefix + String(key)); },
      clear() { for (const key of storageKeys(original)) original.removeItem(key); }
    });
    Object.defineProperty(window, name, { value: facade, configurable: false });
  }
  // Fresh runs start on photo. Reloads retain the app's actual route/menu writes.
  localStorage.setItem("fanhao.serverUrl", location.origin);
  if (localStorage.getItem("fanhao.android.lastView") === null) {
    localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "channel", params: { mode: "photo", category: "我喜欢的" } }));
    localStorage.setItem("fanhao.android.galleryMode.v1", "photo");
  }
  const databaseNames = new Set();
  const databaseFactory = window.indexedDB;
  const open = databaseFactory.open.bind(databaseFactory);
  const deleteDatabase = databaseFactory.deleteDatabase.bind(databaseFactory);
  databaseFactory.open = (name, ...args) => {
    const scopedName = prefix + String(name);
    databaseNames.add(scopedName);
    return open(scopedName, ...args);
  };
  databaseFactory.deleteDatabase = (name) => deleteDatabase(prefix + String(name));
  if (typeof databaseFactory.databases === "function") {
    const databases = databaseFactory.databases.bind(databaseFactory);
    databaseFactory.databases = async () => (await databases()).filter((item) => item.name?.startsWith(prefix))
      .map((item) => ({ ...item, name: item.name.slice(prefix.length) }));
  }
  if (window.caches) {
    const original = window.caches;
    Object.defineProperty(window, "caches", { value: Object.freeze({
      open: (name) => original.open(prefix + String(name)),
      delete: (name) => original.delete(prefix + String(name)),
      has: (name) => original.has(prefix + String(name)),
      keys: async () => (await original.keys()).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
      async match(request, options = {}) {
        if (options.cacheName) return original.match(request, { ...options, cacheName: prefix + String(options.cacheName) });
        for (const key of await original.keys()) {
          if (!key.startsWith(prefix)) continue;
          const response = await (await original.open(key)).match(request, options);
          if (response) return response;
        }
        return undefined;
      }
    }), configurable: false });
  }
  // Requests remain real fetch calls. CSP is the network fence, including any
  // manually entered server URL. Quick-server controls also stay in the fixture.
  document.addEventListener("DOMContentLoaded", () => {
    for (const button of document.querySelectorAll("[data-url]")) {
      button.dataset.url = location.origin;
      button.textContent = "隔离合成服务";
    }
  }, { once: true });
  Object.defineProperty(window, "__galleryNavigationFixture", { value: Object.freeze({
    runId, requestsUrl: `/fixture/requests?run=${runId}`,
    get databaseNames() { return [...databaseNames]; },
    scope: "Real Android app/modules/CSS; synthetic API; namespaced browser persistence; no native playback."
  }) });
})();
