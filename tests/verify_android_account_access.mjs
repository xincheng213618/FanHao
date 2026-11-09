import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { accountLoginMessage, isServerAuthenticationError, requiresUserAccount } from "../android-client/www/js/account-access.js";
import { prepareAccountOwner } from "../android-client/www/js/account-owner.js";
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

const LIBRARY_CACHE_PATH = "/api/library";
const LIBRARY_METADATA_CACHE_PATH = "/api/library?peopleRevision=metadata";
const LIBRARY_CACHE_TOUCH_INTERVAL_MS = 30 * 60 * 1000;
const LIBRARY_CACHE_WRITE_MIN_PEOPLE = 4096;
const PEOPLE_REVISION = "a".repeat(64);
const OTHER_PEOPLE_REVISION = "b".repeat(64);
const libraryRequestPath = (revision = "") => `${LIBRARY_CACHE_PATH}?peopleRevision=${revision}`;

function shell(options = {}) {
  const calls = { status: [], connection: [], registered: [], login: [], settings: [], panels: [], rendered: [], written: [], invalidated: [], read: [], fetched: [] };
  const root = element();
  const snapshot = { people: [{ id: "cached-person" }], totals: { people: 1 } };
  const cacheRecords = new Map(Object.entries(options.cacheRecords || {}));
  if (options.cached) cacheRecords.set(LIBRARY_CACHE_PATH, { payload: snapshot, updatedAt: 1 });
  const accountStates = new Map();
  const payloadOwners = new WeakMap();
  let cacheGeneration = 0;
  const captureOwner = (base) => {
    const origin = new URL(base).origin;
    return { origin, ...(accountStates.get(origin) || { owner: "guest", revision: 0, tokenKnown: true }) };
  };
  const isOwnerCurrent = (scope) => {
    if (!scope) return false;
    const current = captureOwner(scope.origin);
    return current.owner === scope.owner && current.revision === scope.revision;
  };
  const captureFence = (baseUrl, account = captureOwner(baseUrl)) => ({ baseUrl, account, epoch: 0, generation: cacheGeneration });
  const markOwned = (payload, owner) => {
    if (owner && payload && typeof payload === "object") payloadOwners.set(payload, owner);
    return payload;
  };
  const fetch = options.fetchJson || (async () => ({ required: true, authenticated: false, accountLoginRequired: true }));
  const c = {
    URL, queueMicrotask, accountLoginMessage, isServerAuthenticationError, requiresUserAccount,
    activeUrl: "http://current.example", accountSettingsServer: "", connectionAttempt: 0, connectionPending: false, connectionPendingUrl: "",
    libraryLoadPromise: null, libraryLoadGeneration: 0, libraryLoadError: null, library: null,
    currentView: "people", androidModuleRegistry: null, LIBRARY_CACHE_PATH, LIBRARY_METADATA_CACHE_PATH, LIBRARY_CACHE_TOUCH_INTERVAL_MS, LIBRARY_CACHE_WRITE_MIN_PEOPLE,
    els: { serverUrl: element(), serverPassword: element(), settingsOverlay: element(), personPreview: element(), viewMeta: element(), viewContent: element() },
    document: { getElementById: () => root, createElement: element },
    normalizeUrl(value) { return new URL(value.includes("://") ? value : `http://${value}`).origin; },
    setStatus: (...args) => calls.status.push(args), setConnection: (...args) => calls.connection.push(args),
    syncConnectionControls() {},
    registerServerAuthentication: (url) => calls.registered.push(url),
    loginToServer: async (...args) => { calls.login.push(args); },
    async fetchJson(base, path, requestOptions) {
      calls.fetched.push({ base, path, options: requestOptions });
      const owner = requestOptions?.accountScope || captureOwner(base);
      const data = await fetch(base, path, requestOptions);
      return markOwned(data, options.responseOwner ? options.responseOwner(owner, data) : owner);
    },
    async readCachedJson(base, path, readOptions) {
      calls.read.push({ base, path, options: readOptions });
      const entry = cacheRecords.get(path);
      if (!entry) return null;
      markOwned(entry.payload, entry.owner || readOptions?.fence?.account || captureOwner(base));
      return entry;
    },
    async writeCachedJson(...args) {
      calls.written.push(args);
      cacheRecords.set(args[1], { payload: args[2], updatedAt: 2,
        ...(args[3]?.withRecordId ? { recordId: `1-2-3-${calls.written.length + 4}` } : {}) });
    },
    captureAccountOwner: captureOwner, isAccountOwnerCurrent: isOwnerCurrent, prepareAccountOwner: async base => captureOwner(base),
    accountPayloadOwner: value => payloadOwners.get(value) || null,
    captureCachedJsonFence: captureFence,
    isCachedJsonFenceCurrent: fence => Boolean(fence && fence.generation === cacheGeneration && isOwnerCurrent(fence.account)),
    currentViewNeedsLibrary: () => true,
    scheduleLibraryCacheWrite: options.scheduleLibraryCacheWrite || (write => write()),
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
  vm.runInNewContext(["connectToServer", "showAccountLogin", "loadDashboard", "mergeLibraryMetadata", "isLibrarySnapshot", "renderLibraryAvailability"].map(appFunction).join("\n"), c);
  return { c, calls, root, snapshot, cacheRecords,
    setOwner(owner) {
      const current = captureOwner(c.activeUrl);
      accountStates.set(current.origin, { owner, revision: current.revision + 1, tokenKnown: true });
    },
    invalidateResponseCache() { cacheGeneration++; cacheRecords.clear(); }
  };
}

const denied = (extra = {}) => Object.assign(new Error("需要用户账号"), { status: 401, statusCode: 401, payload: { accountLoginRequired: true, reason: "account-required" }, ...extra });
const versionedLibrary = (id, revision = PEOPLE_REVISION) => ({
  scope: "main", peopleRevision: revision, people: [{ id }], totals: { people: 1, videos: 2 },
  user: { favoriteCount: 1 }, access: { mode: "local" }, uiConfig: { theme: "old" }, lastScanError: "old"
});
const matchingLibraryMetadata = (overrides = {}) => ({
  scope: "main", peopleRevision: PEOPLE_REVISION, peopleUnchanged: true, totals: { people: 1, videos: 8 },
  user: { favoriteCount: 5 }, access: { mode: "lan" }, uiConfig: { theme: "fresh" }, lastScanError: null, ...overrides
});
const libraryCache = (payload, recordId = "1-2-3-4") => ({ [LIBRARY_CACHE_PATH]: { payload, updatedAt: 1, recordId } });

await test("a deferred cold canonical write cannot overwrite a newer same-source refresh", async () => {
  function largeSnapshot(name, revision) {
    const data = versionedLibrary(name, revision);
    data.people = Array.from({ length: LIBRARY_CACHE_WRITE_MIN_PEOPLE }, (_, index) => ({ id: `${name}-${index}` }));
    data.totals.people = data.people.length;
    return data;
  }
  const cold = largeSnapshot("cold", PEOPLE_REVISION);
  const warm = largeSnapshot("warm", OTHER_PEOPLE_REVISION);
  const scheduled = [];
  const scheduleLibraryCacheWrite = (write) => scheduled.push(write);
  const replies = [cold, warm];
  const { c, calls, cacheRecords } = shell({ fetchJson: async () => replies.shift(), scheduleLibraryCacheWrite });

  assert.equal(await c.loadDashboard(), true);
  assert.equal(c.library, cold);
  assert.deepEqual(calls.rendered, [cold]);
  assert.equal(calls.written.length, 0);
  assert.equal(scheduled.length, 1);

  assert.equal(await c.loadDashboard(), true);
  assert.equal(c.library, warm);
  assert.equal(scheduled.length, 1, "a large warm refresh writes immediately");
  assert.equal(cacheRecords.get(LIBRARY_CACHE_PATH).payload, warm);
  scheduled.shift()();
  assert.equal(calls.written.length, 1, "the retired cold write must not dispatch");
  assert.equal(calls.written[0][1], LIBRARY_CACHE_PATH);
  assert.equal(cacheRecords.get(LIBRARY_CACHE_PATH).payload, warm);

  const small = versionedLibrary("small");
  const smallShell = shell({ fetchJson: async () => small, scheduleLibraryCacheWrite });
  assert.equal(await smallShell.c.loadDashboard(), true);
  assert.equal(smallShell.cacheRecords.get(LIBRARY_CACHE_PATH).payload, small);
  assert.deepEqual(scheduled, [], "a small cold result writes immediately");
});

await test("leaving People before cached paint does not wait for a People frame to touch the cache", async () => {
  const snapshot = versionedLibrary("aged");
  snapshot.people = Array.from({ length: LIBRARY_CACHE_WRITE_MIN_PEOPLE }, (_, index) => ({ id: String(index) }));
  snapshot.totals.people = snapshot.people.length;
  let touches = 0;
  const { c } = shell({
    cacheRecords: libraryCache(snapshot),
    fetchJson: async () => { throw new Error("offline"); },
    scheduleLibraryCacheWrite: () => assert.fail("Tools should not queue a People frame")
  });
  const read = c.readCachedJson;
  c.readCachedJson = async (base, path, options) => {
    const entry = await read(base, path, options);
    if (path === LIBRARY_CACHE_PATH) {
      options.scheduleTouch((isCurrent) => { if (isCurrent()) touches++; }, entry);
      c.currentView = "tools";
    }
    return entry;
  };

  assert.equal(await c.loadDashboard(), false);
  assert.equal(c.library, snapshot);
  assert.equal(touches, 1);
});
const nextTask = () => new Promise(resolve => setImmediate(resolve));

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
  const { c, calls } = shell({ fetchJson: async (base, path) => new URL(path, base).pathname === LIBRARY_CACHE_PATH ? { people: [], totals: {} }
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

await test("an unchanged people revision updates fresh dashboard metadata and reuses the exact cached people", async () => {
  const cached = versionedLibrary("cached-person");
  const metadata = matchingLibraryMetadata();
  let offline = false;
  const { c, calls, cacheRecords, setOwner } = shell({ cacheRecords: libraryCache(cached), fetchJson: async () => {
    if (offline) throw Object.assign(new Error("Offline"), { status: 503 });
    return metadata;
  } });
  setOwner("account:fixture");
  assert.equal(await c.loadDashboard(), true);
  assert.deepEqual(calls.fetched.map(call => call.path), [libraryRequestPath(PEOPLE_REVISION)]);
  assert.deepEqual(calls.read.map(call => call.path), [LIBRARY_CACHE_PATH, LIBRARY_METADATA_CACHE_PATH]);
  assert.equal(calls.read[0].options.touchIntervalMs, LIBRARY_CACHE_TOUCH_INTERVAL_MS);
  assert.equal(calls.read[1].options.touchIntervalMs, Infinity);
  assert.equal(calls.read[0].options.fence, calls.read[1].options.fence);
  assert.equal(c.library.people, cached.people);
  assert.equal(Object.hasOwn(c.library, "peopleUnchanged"), false, "rendered snapshots do not retain the wire marker");
  for (const field of ["totals", "user", "uiConfig", "access", "lastScanError"]) {
    assert.deepEqual(c.library[field], metadata[field], `${field} comes from the current response`);
  }
  assert.deepEqual(calls.written.map(write => write[1]), [LIBRARY_METADATA_CACHE_PATH]);
  const [, , overlay, options] = calls.written[0];
  assert.equal(options.fence, calls.read[0].options.fence);
  assert.equal(options.fence.account.owner, "account:fixture");
  assert.equal(overlay.snapshotRecordId, cacheRecords.get(LIBRARY_CACHE_PATH).recordId);
  assert.equal(overlay.metadata, metadata);
  assert.equal(Object.hasOwn(overlay, "people"), false);
  assert.equal(cacheRecords.get(LIBRARY_CACHE_PATH).payload, cached, "a match never clones and overwrites the full cache");

  offline = true;
  assert.equal(await c.loadDashboard(), false);
  assert.equal(c.library.people, cached.people);
  assert.equal(c.library.user.favoriteCount, 5, "offline fallback can restore the matching metadata overlay");
  assert.equal(calls.written.length, 1);
  assert.match(calls.status.at(-1)[0], /继续显示本地缓存/);

  const replacement = { ...cached, user: { favoriteCount: 9 } };
  cacheRecords.set(LIBRARY_CACHE_PATH, { ...cacheRecords.get(LIBRARY_CACHE_PATH), payload: replacement, recordId: "1-2-3-9" });
  assert.equal(await c.loadDashboard(), false);
  assert.equal(c.library, replacement, "an old overlay cannot shadow a full row with the same revision and timestamp");
});

await test("a full reply from an older server works for cold, legacy and versioned caches", async () => {
  const full = { people: [{ id: "legacy-response" }], totals: { people: 1 } };
  const legacy = { people: [{ id: "legacy-cache" }], totals: { people: 1 } };
  const current = versionedLibrary("new-client-cache");
  for (const [cached, revision, recordId] of [[null, ""], [legacy, ""], [current, "", null], [current, PEOPLE_REVISION]]) {
    const { c, calls } = shell({ cacheRecords: cached && libraryCache(cached, recordId), fetchJson: async () => full });
    assert.equal(await c.loadDashboard(), true);
    assert.equal(c.library, full);
    assert.deepEqual(calls.fetched.map(call => call.path), [libraryRequestPath(revision)]);
    assert.deepEqual(calls.written.map(write => write[1]), [LIBRARY_CACHE_PATH]);
    assert.equal(calls.written[0][3]?.withRecordId, true);
    if (!revision) assert.deepEqual(calls.read.map(call => call.path), [LIBRARY_CACHE_PATH]);
  }
});

await test("incompatible or unowned partial replies retry once with a full request", async () => {
  const full = versionedLibrary("fresh-person", OTHER_PEOPLE_REVISION);
  for (const invalid of [{ peopleRevision: OTHER_PEOPLE_REVISION }, { scope: "western" }, { totals: { people: 2 } }, null]) {
    let requests = 0;
    const { c, calls } = shell({ cacheRecords: libraryCache(versionedLibrary("cached-person")),
      responseOwner: (owner, data) => invalid === null && data.peopleUnchanged ? null : owner,
      fetchJson: async () => ++requests === 1 ? matchingLibraryMetadata(invalid) : full });
    assert.equal(await c.loadDashboard(), true);
    assert.equal(c.library, full);
    assert.deepEqual(calls.fetched.map(call => call.path), [libraryRequestPath(PEOPLE_REVISION), libraryRequestPath()]);
    assert.deepEqual(calls.written.map(write => write[1]), [LIBRARY_CACHE_PATH]);
    assert.equal(calls.rendered.length, 2, "the malformed partial cannot render between cache and fresh full data");
  }
});

await test("an account assertion failure never promotes or retries a matched request", async () => {
  const error = Object.assign(new Error("账号已切换，请刷新后重试"), { code: "ACCOUNT_CHANGED", status: 409 });
  const { c, calls } = shell({ cacheRecords: libraryCache(versionedLibrary("cached-person")), fetchJson: async () => { throw error; } });
  assert.equal(await c.loadDashboard(), false);
  assert.equal(c.library, null);
  assert.equal(c.libraryLoadError, error);
  assert.deepEqual(calls.fetched.map(call => call.path), [libraryRequestPath(PEOPLE_REVISION)]);
  assert.deepEqual(calls.written, []);
  assert.equal(calls.settings.length, 0);
});

await test("a cache clear during a matched response forces a full read without repopulating storage", async () => {
  const held = deferred();
  const full = versionedLibrary("fresh-after-clear", OTHER_PEOPLE_REVISION);
  let requests = 0;
  const { c, calls, cacheRecords, invalidateResponseCache } = shell({ cacheRecords: libraryCache(versionedLibrary("retired")),
    fetchJson: async () => ++requests === 1 ? held.promise : full });
  const loading = c.loadDashboard();
  await nextTask();
  assert.deepEqual(calls.fetched.map(call => call.path), [libraryRequestPath(PEOPLE_REVISION)]);
  invalidateResponseCache();
  held.resolve(matchingLibraryMetadata());
  assert.equal(await loading, true);
  assert.equal(c.library, full);
  assert.deepEqual(calls.fetched.map(call => call.path), [libraryRequestPath(PEOPLE_REVISION), libraryRequestPath()]);
  assert.deepEqual(calls.written, []);
  assert.equal(cacheRecords.size, 0);
});

await test("a stale full dashboard response retries once and an obsolete or failed retry preserves the current view", async () => {
  for (const retryOutcome of ["current", "invalidated", "offline"]) {
    const replies = [deferred(), deferred()];
    const cached = versionedLibrary("cached-person");
    let requests = 0;
    const { c, calls, cacheRecords, invalidateResponseCache } = shell({ cacheRecords: libraryCache(cached), fetchJson: () => {
      const reply = replies[requests++];
      assert(reply, "a dashboard load may only retry once");
      return reply.promise;
    } });
    c.library = versionedLibrary("previous-person");
    c.els.favoriteCount = element();
    c.formatNumber = String;
    vm.runInNewContext(appFunction("renderUserState"), c);

    const loading = c.loadDashboard();
    await nextTask();
    assert.deepEqual(calls.fetched.map(call => call.path), [libraryRequestPath(PEOPLE_REVISION)]);
    c.renderUserState({ favoriteCount: 9 });
    invalidateResponseCache();
    replies[0].resolve(versionedLibrary("stale-full-person", OTHER_PEOPLE_REVISION));
    await nextTask();
    assert.deepEqual(calls.fetched.map(call => call.path), [libraryRequestPath(PEOPLE_REVISION), libraryRequestPath()]);
    assert.equal(c.library, cached);
    assert.equal(c.library.user.favoriteCount, 9, "the superseded reply cannot overwrite a newer personal summary");
    assert.deepEqual(calls.rendered, [cached]);

    const retry = { ...versionedLibrary("retry-person", OTHER_PEOPLE_REVISION), user: { favoriteCount: 9 } };
    const invalidateRetry = retryOutcome !== "current";
    if (invalidateRetry) {
      c.renderUserState({ favoriteCount: 11 });
      invalidateResponseCache();
    }
    if (retryOutcome === "offline") replies[1].reject(Object.assign(new Error("Offline"), { status: 503 }));
    else replies[1].resolve(retry);
    assert.equal(await loading, !invalidateRetry);
    if (invalidateRetry) {
      assert.equal(c.library, cached);
      assert.equal(c.library.user.favoriteCount, 11);
      assert.deepEqual(calls.rendered, [cached]);
      if (retryOutcome === "offline") assert.match(calls.status.at(-1)[0], /继续显示已加载内容/);
      else {
        assert.deepEqual(calls.status.at(-1), ["资料库状态再次变化，请重试。", "error"]);
        assert.deepEqual(calls.connection.at(-1), ["等待刷新", false]);
      }
    } else {
      assert.equal(c.library, retry);
      assert.deepEqual(calls.rendered, [cached, retry]);
    }
    assert.equal(calls.fetched.length, 2);
    assert.deepEqual(calls.written, [], "a retry cannot revive the original invalidated storage fence");
    assert.equal(cacheRecords.size, 0);
    assert.equal(c.libraryLoadPromise, null);
  }
});

await test("a late matched response cannot update the library after the account changes", async () => {
  const held = deferred();
  const full = versionedLibrary("second-account-person", OTHER_PEOPLE_REVISION);
  let requests = 0;
  const { c, calls, cacheRecords, setOwner } = shell({ cacheRecords: libraryCache(versionedLibrary("first-account-person")),
    fetchJson: async () => ++requests === 1 ? held.promise : full });
  setOwner("account:first");
  const loading = c.loadDashboard();
  await nextTask();
  assert.deepEqual(calls.fetched.map(call => call.path), [libraryRequestPath(PEOPLE_REVISION)]);
  setOwner("account:second");
  // The account event retires the old load and clears in-memory presentation.
  c.libraryLoadGeneration++;
  c.libraryLoadPromise = null;
  c.library = null;
  cacheRecords.clear();
  assert.equal(await c.loadDashboard(), true);
  held.resolve(matchingLibraryMetadata());
  assert.equal(await loading, false);
  assert.equal(c.library, full);
  assert.deepEqual(calls.fetched.map(call => call.path), [libraryRequestPath(PEOPLE_REVISION), libraryRequestPath()]);
  assert.deepEqual(calls.written.map(write => write[1]), [LIBRARY_CACHE_PATH]);
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

await test("cancelling one native session waiter keeps a live resolver or unsignaled fetch on the same lookup", async () => {
  const originalCapacitor = globalThis.Capacitor;
  try {
    for (const consumer of ["resolver", "unsignaled-fetch"]) {
      const origin = `http://session-shared-${consumer}.example`;
      const pending = deferred(), calls = [];
      let lookups = 0;
      globalThis.Capacitor = { Plugins: { FanHaoAuth: { getSession() { lookups++; return pending.promise; } } } };
      const host = { fetch: async (...args) => { calls.push(args); return { ok: true }; } };
      installServerAuthentication(() => origin, host);
      const retiring = new AbortController(), active = new AbortController();
      const obsolete = prepareAccountOwner(origin, { signal: retiring.signal });
      const live = consumer === "resolver"
        ? prepareAccountOwner(origin, { signal: active.signal })
        : host.fetch(`${origin}/api/short-videos`);
      try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(lookups, 1);
        assert.equal(calls.length, 0);
        const rejected = assert.rejects(obsolete, { name: "AbortError" });
        retiring.abort();
        await rejected;
        assert.equal(active.signal.aborted, false);
        pending.resolve({ token: "shared-session-token" });
        await live;
        await host.fetch(`${origin}/api/short-videos`);
        assert.equal(lookups, 1, "one waiter abort must not retire the reusable lookup");
        const expectedCalls = consumer === "resolver" ? 1 : 2;
        assert.deepEqual(calls.map(([, options]) => options.headers.get("Authorization")),
          Array(expectedCalls).fill("Bearer shared-session-token"));
      } finally {
        pending.resolve({ token: "fixture-cleanup" });
        await Promise.allSettled([obsolete, live]);
      }
    }
  } finally { globalThis.Capacitor = originalCapacitor; }
});

await test("cancelling all session waiters admits a replacement before the retired bridge lookup settles", async () => {
  const originalCapacitor = globalThis.Capacitor;
  const origin = "http://session-all-cancelled.example";
  const lookups = [], calls = [], requests = [];
  const host = { fetch: async (...args) => { calls.push(args); return { ok: true }; } };
  try {
    globalThis.Capacitor = { Plugins: { FanHaoAuth: { getSession() {
      const pending = deferred();
      lookups.push(pending);
      return pending.promise;
    } } } };
    installServerAuthentication(() => origin, host);
    const controllers = [new AbortController(), new AbortController()];
    for (const { signal } of controllers) requests.push(host.fetch(`${origin}/api/short-videos`, { signal }));
    const cancelled = Promise.all(requests.map(request => assert.rejects(request, { name: "AbortError" })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lookups.length, 1);
    for (const controller of controllers) controller.abort();
    const current = host.fetch(`${origin}/api/short-videos`);
    requests.push(current);
    await cancelled;
    assert.equal(calls.length, 0);

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lookups.length, 2, "an immediate replacement must dispatch while the old bridge request is held");
    lookups[1].resolve({ token: "current-lookup-token" });
    await current;
    lookups[0].resolve({ token: "retired-lookup-token" });
    await new Promise(resolve => setImmediate(resolve));
    const reused = host.fetch(`${origin}/api/short-videos`);
    requests.push(reused);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lookups.length, 2);
    await reused;
    assert.deepEqual(calls.map(([, options]) => options.headers.get("Authorization")), [
      "Bearer current-lookup-token", "Bearer current-lookup-token"
    ]);
  } finally {
    for (const pending of lookups) pending.resolve({ token: "fixture-cleanup" });
    await Promise.allSettled(requests);
    globalThis.Capacitor = originalCapacitor;
  }
});

await test("late native session success cannot send an obsolete token after explicit login", async () => {
  const originalCapacitor = globalThis.Capacitor;
  const origin = "http://session-late-success-after-login.example";
  const pending = deferred(), calls = [];
  const host = { fetch: async (...args) => { calls.push(args); return { ok: true }; } };
  let oldRequest, oldResolver;
  try {
    globalThis.Capacitor = { Plugins: { FanHaoAuth: {
      getSession: () => pending.promise,
      loginAccount: async () => ({ token: "explicit-login-token" })
    } } };
    installServerAuthentication(() => origin, host);
    oldRequest = host.fetch(`${origin}/api/short-videos`);
    oldResolver = prepareAccountOwner(origin);
    await authenticateAccount(origin, "login", { username: "fixture", password: "fixture" });
    const retired = Promise.all([oldRequest, oldResolver].map(request => assert.rejects(request, { code: "ACCOUNT_CHANGED" })));
    pending.resolve({ token: "retired-session-token" });
    await retired;
    assert.equal(calls.length, 0, "the retired session cannot dispatch a request with its old credentials");
    await host.fetch(`${origin}/api/short-videos`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].headers.get("Authorization"), "Bearer explicit-login-token");
  } finally {
    pending.resolve({ token: "fixture-cleanup" });
    await Promise.allSettled([oldRequest, oldResolver]);
    globalThis.Capacitor = originalCapacitor;
  }
});

console.log("android-account-access: ok (connection/startup, cache boundaries, native session ownership, retry and origin isolation)");
