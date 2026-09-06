import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { accountLoginMessage, isServerAuthenticationError, requiresUserAccount } from "../android-client/www/js/account-access.js";
import { authenticateAccount, installServerAuthentication, registerServerAuthentication } from "../android-client/www/js/server-auth.js";

const appSource = fs.readFileSync(new URL("../android-client/www/app.js", import.meta.url), "utf8");
function appFunction(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(appSource);
  assert(match, `Missing real Android function: ${name}`);
  const remaining = appSource.slice(match.index);
  const next = /\r?\n(?:async )?function\s/.exec(remaining);
  assert(next, `Missing function boundary: ${name}`);
  return remaining.slice(0, next.index);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function element() {
  return { value: "", hidden: false, textContent: "", innerHTML: "", children: [], listeners: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, handler) { this.listeners[name] = handler; }, setAttribute() {},
    scrollIntoView() { this.scrolled = true; } };
}

function shell(options = {}) {
  const calls = { status: [], connection: [], registered: [], login: [], settings: [], panels: [], rendered: [], written: [], invalidated: [] };
  const root = element();
  const snapshot = { people: [{ id: "cached-person" }], totals: { people: 1 } };
  const c = {
    URL, accountLoginMessage, isServerAuthenticationError, requiresUserAccount,
    activeUrl: "http://current.example", accountSettingsServer: "", connectionAttempt: 0, connectionPending: false, connectionPendingUrl: "",
    libraryLoadPromise: null, libraryLoadGeneration: 0, libraryLoadError: null, library: null,
    currentView: "people", androidModuleRegistry: null, LIBRARY_CACHE_PATH: "/api/library",
    els: { serverUrl: element(), serverPassword: element(), settingsOverlay: element(), personPreview: element(), viewMeta: element(), viewContent: element() },
    document: { getElementById: () => root, createElement: element },
    normalizeUrl(value) { return new URL(value.includes("://") ? value : `http://${value}`).origin; },
    setStatus: (...args) => calls.status.push(args), setConnection: (...args) => calls.connection.push(args),
    syncConnectionControls() {},
    registerServerAuthentication: (url) => calls.registered.push(url),
    loginToServer: async (...args) => { calls.login.push(args); },
    fetchJson: options.fetchJson || (async () => ({ required: true, authenticated: false, accountLoginRequired: true })),
    readCachedJson: async () => options.cached ? { payload: snapshot, updatedAt: 1 } : null,
    writeCachedJson: async (...args) => { calls.written.push(args); },
    renderDashboard: (data) => calls.rendered.push(data), renderOffline: () => { calls.offline = (calls.offline || 0) + 1; },
    refreshLibraryDependentView: () => { calls.libraryViewRefreshes = (calls.libraryViewRefreshes || 0) + 1; },
    refreshAccountSettings: () => { calls.panels.push(c.els.serverUrl.value); c.accountSettingsServer = c.els.serverUrl.value; },
    showSettings(settings) {
      calls.settings.push(settings);
      if (c.els.settingsOverlay.hidden) { c.els.settingsOverlay.hidden = false; c.refreshAccountSettings(); }
    },
    connectionModeLabel: () => "电脑端", cacheAgeText: () => "刚刚",
    loadImageLibrarySummary() {}, loadNovelSummary() {}, loadMusicSummary() {}, loadShortVideoSummary() {},
    updateServiceHealth() {}, updateCacheStatus() {}, refreshAndroidUpdateSource() {}, refreshModuleCatalog() {}, renderCurrentViewPreservingScroll() {}, renderCurrentView() {},
    updateServer(url) { c.activeUrl = url; calls.updated = url; },
    workViews: { renderContinuePreview() {}, pageDataService: { invalidate: (...args) => calls.invalidated.push(args) } }
  };
  c.els.settingsOverlay.hidden = true;
  c.els.serverUrl.value = c.activeUrl;
  vm.runInNewContext(["connectToServer", "showAccountLogin", "loadDashboard", "isLibrarySnapshot", "renderLibraryAvailability"].map(appFunction).join("\n"), c);
  return { c, calls, root, snapshot };
}

const denied = (extra = {}) => Object.assign(new Error("需要用户账号"), { status: 401, statusCode: 401, payload: { accountLoginRequired: true, reason: "account-required" }, ...extra });

await test("strict connection selects the requested account panel and never submits an obsolete access password", async () => {
  const { c, calls } = shell();
  await c.connectToServer("http://requested.example", "old-password");
  assert.equal(c.activeUrl, "http://current.example", "denied service cannot replace a connected service");
  assert.deepEqual(calls.registered, ["http://requested.example"]);
  assert.deepEqual(calls.login, [], "strict policy must not send the old access password");
  assert.deepEqual(calls.panels, ["http://requested.example"]);
  assert.equal(calls.settings.at(-1).section, "account");
  assert.match(calls.status.at(-1)[0], /用户中心/);
  assert.doesNotMatch(calls.status.at(-1)[0], /原访问密码/);
  assert.equal(c.connectionPending, false);
});

await test("legacy remote-password connection remains available when the account policy is off", async () => {
  let checks = 0;
  const { c, calls } = shell({ fetchJson: async (_url, path) => path === "/api/library" ? { people: [], totals: {} }
    : { required: true, authenticated: ++checks > 1, accountLoginRequired: false } });
  assert.equal(await c.connectToServer("http://legacy.example", "old-password"), true);
  assert.deepEqual(calls.login, [["http://legacy.example", "old-password"]]);
  assert.equal(c.activeUrl, "http://legacy.example");
  assert.equal(calls.status.at(-1)[0], "已连接");
});

await test("401 and strict 403 reconnect errors open the account section even when settings were already open", async () => {
  for (const error of [denied(), denied({ status: 403, statusCode: 403 })]) {
    const { c, calls, root } = shell({ fetchJson: async () => { throw error; } });
    c.els.settingsOverlay.hidden = false;
    c.accountSettingsServer = "http://requested.example";
    await c.connectToServer("http://requested.example");
    assert.equal(calls.panels.at(-1), "http://requested.example");
    assert.equal(root.scrolled, true);
    assert.doesNotMatch(calls.status.at(-1)[0], /原访问密码/);
  }
});

await test("superseded connection failures cannot reopen settings for an old service", async () => {
  const pending = deferred();
  const { c, calls } = shell({ fetchJson: () => pending.promise });
  const request = c.connectToServer("http://outdated.example");
  c.connectionAttempt += 1;
  pending.reject(denied());
  await request;
  assert.equal(calls.settings.length, 0);
  assert.equal(calls.status.length, 0);
});

await test("authenticated denial on startup stops cached-library access and presents a login action without deleting the cache", async () => {
  for (const cached of [false, true]) {
    const { c, calls, snapshot } = shell({ cached, fetchJson: async () => { throw denied(); } });
    c.library = snapshot;
    assert.equal(await c.loadDashboard(), false);
    assert.equal(c.library, null, "an explicit authentication failure cannot fall back to the previous account library");
    assert.equal(c.libraryLoadError.statusCode, 401);
    assert.equal(calls.status.at(-1)[0], "此服务需要用户账号，请在用户中心登录或注册。");
    assert.equal(calls.connection.at(-1)[0], "需要登录");
    assert.deepEqual(calls.panels, ["http://current.example"]);
    assert.deepEqual(calls.written, []);
    assert.equal(snapshot.people.length, 1, "locally stored data must not be destructively cleared");
    c.renderLibraryAvailability();
    const panel = c.els.viewContent.children[0];
    assert.equal(panel.children[0].textContent, "请登录用户账号");
    const accountButton = panel.children[2].children[1];
    assert.equal(accountButton.textContent, "打开用户中心");
    accountButton.listeners.click();
    assert.equal(calls.panels.at(-1), "http://current.example");
  }
});

await test("ordinary offline startup retains local content and does not interrupt with an account prompt", async () => {
  const { c, calls, snapshot } = shell({ cached: true, fetchJson: async () => { throw Object.assign(new Error("Offline"), { status: 503 }); } });
  assert.equal(await c.loadDashboard(), false);
  assert.equal(c.library, snapshot);
  assert.match(calls.status.at(-1)[0], /继续显示本地缓存/);
  assert.equal(calls.settings.length, 0);
  assert.equal(calls.offline || 0, 0);
});

await test("a startup failure from an old server cannot open or rewrite the new server's account panel", async () => {
  const pending = deferred();
  const { c, calls } = shell({ fetchJson: () => pending.promise });
  const request = c.loadDashboard();
  await new Promise((resolve) => setImmediate(resolve));
  c.activeUrl = "http://new-service.example";
  c.els.serverUrl.value = c.activeUrl;
  pending.reject(denied());
  await request;
  assert.equal(calls.panels.length, 0);
  assert.equal(c.els.serverUrl.value, c.activeUrl);
});

await test("expired account sessions require account login even with the optional policy off", () => {
  assert.equal(requiresUserAccount({ accountLoginRequired: false, reason: "expired-account" }), true);
  assert.doesNotMatch(accountLoginMessage({ reason: "expired-account" }), /原访问密码/);
  assert.equal(isServerAuthenticationError({ status: 403, payload: { reason: "forbidden" } }), false);
  assert.equal(isServerAuthenticationError({ status: 503 }), false);
});

await test("a new account login replaces an older in-flight unauthenticated dashboard request", async () => {
  for (const failureOrder of ["before-new-status", "after-new-library"]) {
    const old = deferred(), status = deferred();
    let libraryRequests = 0;
    const fresh = { people: [{ id: "new-account-person" }], totals: { people: 1 } };
    const { c, calls } = shell({ cached: true, fetchJson: async (_url, path) => {
      if (path === "/api/auth/status") return status.promise;
      return ++libraryRequests === 1 ? old.promise : fresh;
    } });
    const oldRequest = c.loadDashboard();
    await new Promise((resolve) => setImmediate(resolve));
    const connected = c.connectToServer(c.activeUrl);
    if (failureOrder === "before-new-status") {
      old.reject(denied());
      await oldRequest;
      assert.equal(calls.settings.length, 0, "an older 401 cannot interrupt the newer authentication attempt");
    }
    status.resolve({ required: true, authenticated: true, accountLoginRequired: true });
    assert.equal(await connected, true);
    if (failureOrder === "after-new-library") { old.reject(denied()); await oldRequest; }
    assert.equal(libraryRequests, 2, "the new login must fetch a fresh library instead of reusing the denied request");
    assert.equal(c.library, fresh);
    assert.equal(calls.status.at(-1)[0], "已连接");
    assert.equal(c.libraryLoadError, null);
    assert.equal(calls.settings.length, 0);
  }
});

await test("double submitting the same connection does not invalidate or duplicate its active authentication attempt", async () => {
  const status = deferred();
  let authRequests = 0;
  const { c, calls } = shell({ fetchJson: async (_url, path) => {
    if (path === "/api/auth/status") { authRequests += 1; return status.promise; }
    return { people: [], totals: {} };
  } });
  const first = c.connectToServer(c.activeUrl);
  const duplicate = c.connectToServer(c.activeUrl);
  assert.equal(await duplicate, null);
  assert.equal(authRequests, 1);
  status.resolve({ required: true, authenticated: true, accountLoginRequired: true });
  assert.equal(await first, true);
  assert.equal(calls.status.at(-1)[0], "已连接");
  assert.equal(c.connectionPending, false);
});

await test("native session lookup rejection, synchronous error and malformed responses never produce an anonymous request and remain retryable", async () => {
  const originalCapacitor = globalThis.Capacitor;
  try {
    for (const [index, failure] of [() => Promise.reject(new Error("bridge failed")), () => { throw new Error("sync bridge failed"); }, async () => ({})].entries()) {
      let currentServer = `http://native-failure-${index}.example`;
      const calls = [];
      const host = { fetch: async (...args) => { calls.push(args); return { ok: true }; } };
      globalThis.Capacitor = { Plugins: { FanHaoAuth: { getSession: failure } } };
      installServerAuthentication(() => currentServer, host);
      await assert.rejects(host.fetch(`${currentServer}/api/library`), (error) => error.code === "NATIVE_AUTH_UNAVAILABLE");
      assert.equal(calls.length, 0);
      globalThis.Capacitor.Plugins.FanHaoAuth.getSession = async () => ({ token: "usr.fixture-token" });
      await host.fetch(`${currentServer}/api/library`);
      assert.equal(calls[0][1].headers.get("Authorization"), "Bearer usr.fixture-token");
      assert.equal(calls[0][1].redirect, "error");
      currentServer = "http://a-different-current.example";
    }
  } finally { globalThis.Capacitor = originalCapacitor; }
});

await test("only an explicitly registered second server may load its saved native session before switching the active server", async () => {
  const originalCapacitor = globalThis.Capacitor;
  const lookups = [], calls = [];
  const host = { fetch: async (...args) => { calls.push(args); return { ok: true }; } };
  try {
    globalThis.Capacitor = { Plugins: { FanHaoAuth: { getSession: async ({ serverUrl }) => { lookups.push(serverUrl); return { token: "saved-token" }; } } } };
    installServerAuthentication(() => "http://registered-active.example", host);
    await host.fetch("http://arbitrary.example/api/library");
    assert.equal(lookups.length, 0);
    assert.equal(calls.at(-1)[1].headers, undefined);
    registerServerAuthentication("http://chosen.example/path");
    await host.fetch("http://chosen.example/api/auth/status");
    assert.deepEqual(lookups, ["http://chosen.example"]);
    assert.equal(calls.at(-1)[1].headers.get("Authorization"), "Bearer saved-token");
    await host.fetch("https://chosen.example/api/library");
    await host.fetch("http://chosen.example:1234/api/library");
    assert.equal(lookups.length, 1, "changed scheme or port must not inherit trust");
    assert.equal(calls.at(-1)[1].headers, undefined);
  } finally { globalThis.Capacitor = originalCapacitor; }
});

await test("late native lookup failure cannot erase a newer explicit account login", async () => {
  const originalCapacitor = globalThis.Capacitor;
  const pending = deferred(), calls = [];
  const origin = "http://login-race.example";
  const host = { fetch: async (...args) => { calls.push(args); return { ok: true }; } };
  try {
    globalThis.Capacitor = { Plugins: { FanHaoAuth: { getSession: () => pending.promise, loginAccount: async () => ({ token: "new-account-token" }) } } };
    installServerAuthentication(() => origin, host);
    const request = host.fetch(`${origin}/api/library`);
    await authenticateAccount(origin, "login", { username: "test", password: "fixture" });
    pending.reject(new Error("late bridge failure"));
    await assert.rejects(request, { code: "NATIVE_AUTH_UNAVAILABLE" });
    await host.fetch(`${origin}/api/library`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].headers.get("Authorization"), "Bearer new-account-token");
  } finally { globalThis.Capacitor = originalCapacitor; }
});

console.log("android-account-access: ok (actual connection/startup functions, strict-policy login routing, cache boundaries, native lookup failures/retry and origin isolation)");
