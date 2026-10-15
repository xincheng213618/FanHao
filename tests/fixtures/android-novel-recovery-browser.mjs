const byId = id => document.getElementById(id);
const rawOpen = IDBFactory.prototype.open;
const rawDelete = IDBFactory.prototype.deleteDatabase;
const connections = new Set();
const controls = document.querySelectorAll("#fixture-controls button");
const record = { status: "initializing", events: [], errors: [], exports: [], calls: [], checks: {} };
const note = text => { byId("fixture-status").textContent = text; };
const requestValue = request => new Promise((resolve, reject) => {
  request.addEventListener("success", () => resolve(request.result), { once: true });
  request.addEventListener("error", () => reject(request.error), { once: true });
});
const transactionDone = tx => new Promise((resolve, reject) => {
  tx.addEventListener("complete", resolve, { once: true });
  tx.addEventListener("abort", () => reject(tx.error || new Error("Transaction aborted")), { once: true });
});
const digest = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("");
let run;
let baselineHash;
let views;
let pageEpoch = 0;
let route = { view: "tools", params: {} };
let cleaned = false;
const state = window.novelRecoveryFixture = {
  calls: record.calls, listReleases: [], entryReleases: [], holdList: false, holdEntry: false,
  saveMode: "ok", saveCalls: 0,
  refresh() {
    byId("fixture-calls").textContent = "旧库列表 " + record.calls.filter(call => call.method === "list").length
      + " 次，旧库正文 " + record.calls.filter(call => call.method === "entry").length + " 次，保存请求 " + state.saveCalls + " 次";
  }
};
window.addEventListener("error", event => record.errors.push(String(event.error?.message || event.message)));
window.addEventListener("unhandledrejection", event => record.errors.push(String(event.reason?.message || event.reason)));
function safeDatabase(name) {
  if (name !== run.databaseName && name !== run.cacheDatabaseName) throw new Error("Fixture refused database: " + String(name));
}
function wrapDatabases() {
  IDBFactory.prototype.open = function(name, ...args) {
    safeDatabase(name);
    const request = Reflect.apply(rawOpen, this, [name, ...args]);
    const retain = () => connections.add(request.result);
    request.addEventListener("upgradeneeded", retain);
    request.addEventListener("success", retain);
    return request;
  };
  IDBFactory.prototype.deleteDatabase = function(name) { safeDatabase(name); return Reflect.apply(rawDelete, this, [name]); };
  if (navigator.storage?.persist) Object.defineProperty(navigator.storage, "persist", { configurable: true, value: async () => false });
}
function syntheticBooks() {
  return Array.from({ length: 14 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const id = "local:recovery-fixture:" + number;
    const row = {
      id, book: { id, title: "合成旧书 " + number, author: "隔离样本", fileName: "synthetic-" + number + ".txt", sourceKey: "PRIVATE_UNKNOWN_MUST_NOT_EXPORT" },
      chapters: [1, 2].map(chapter => ({ index: chapter, bookId: id, title: "第" + chapter + "章", content: "仅用于恢复验证的合成正文 " + number + "-" + chapter + "。\n中文🙂。" })),
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      unknownEntry: { keep: true }
    };
    if (index === 1) {
      row.book.title += "（部分损坏）";
      row.chapters[1].index = 1;
      row.chapters.push({ index: 3, title: "损坏章", content: null });
    }
    if (index === 2) { row.book.title += "（没有可读正文）"; row.chapters = [{ index: 1, content: null }, { index: 2, content: "" }]; }
    return row;
  });
}
async function readOriginals() {
  const db = await requestValue(indexedDB.open(run.databaseName));
  try {
    const tx = db.transaction("books", "readonly");
    const done = transactionDone(tx);
    const rows = await requestValue(tx.objectStore("books").getAll());
    await done;
    return { version: db.version, rows };
  } finally { db.close(); }
}
async function seed() {
  const rows = syntheticBooks();
  const request = indexedDB.open(run.databaseName, 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("books", { keyPath: "id" });
    store.createIndex("updatedAt", "updatedAt"); store.createIndex("title", "book.title");
    for (const row of rows) store.put(row);
  };
  const db = await requestValue(request); db.close();
  baselineHash = await digest((await readOriginals()).rows);
  record.checks.seedBooks = rows.length;
}
function showView(view, params = {}) {
  if (cleaned) return;
  pageEpoch++;
  const captured = pageEpoch;
  route = { view, params };
  record.events.push({ action: "navigate", view });
  window.dispatchEvent(new CustomEvent("fanhaoViewWillRender", { detail: route }));
  window.dispatchEvent(new CustomEvent("fanhaoViewChanged", { detail: route }));
  const active = () => captured === pageEpoch && !cleaned;
  let result;
  if (view === "novelReader") result = views.renderNovelReader(params.id, params.chapterIndex || 1, active);
  else if (view === "novelDetail") result = views.renderNovelDetail(params.id, active);
  else if (view === "novels") result = views.renderNovelList(active);
  else { byId("view").innerHTML = "<h2>已离开小说页</h2><p>迟到的读取或导出不得覆盖这里。</p>"; byId("title").textContent = "隔离测试主页"; }
  return Promise.resolve(result).catch(error => { record.errors.push(String(error.message || error)); note("未处理页面失败：" + error.message); });
}
async function inspect() {
  const before = await readOriginals();
  record.checks.originalVersion = before.version;
  record.checks.originalBooks = before.rows.length;
  record.checks.originalHash = await digest(before.rows);
  record.checks.originalUnchanged = record.checks.originalHash === baselineHash;
  record.checks.unknownExported = record.exports.some(item => item.text.includes("PRIVATE_UNKNOWN_MUST_NOT_EXPORT"));
  record.checks.activeView = route.view;
  record.saveCalls = state.saveCalls;
  record.status = record.errors.length || !record.checks.originalUnchanged || record.checks.unknownExported ? "failed" : "observed";
  await publish();
  note("核对完成：旧库v" + before.version + "，" + before.rows.length + "本，原记录" + (record.checks.originalUnchanged ? "未改变" : "已改变") + "；保存请求 " + state.saveCalls + " 次。");
}
async function publish() {
  byId("fixture-report").textContent = JSON.stringify(record, null, 2);
  await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) });
}
function bind(id, action) {
  byId(id).onclick = () => Promise.resolve().then(() => {
    record.events.push({ action: "fixture-control", control: id });
    return action();
  }).catch(error => { record.errors.push(String(error.message || error)); note("夹具失败：" + error.message); });
}
async function cleanup() {
  await inspect();
  await showView("tools");
  cleaned = true; pageEpoch++;
  state.holdList = false; state.holdEntry = false;
  state.listReleases.splice(0).forEach(resolve => resolve());
  state.entryReleases.splice(0).forEach(resolve => resolve());
  await Promise.resolve();
  for (const db of connections) { try { db.close(); } catch {} }
  const failures = [];
  for (const name of [run.databaseName, run.cacheDatabaseName]) {
    let timer;
    try { await Promise.race([requestValue(indexedDB.deleteDatabase(name)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Cleanup blocked: " + name)), 4000); })]); }
    catch (error) { failures.push(error.message); }
    finally { clearTimeout(timer); }
  }
  record.cleanup = { generatedNamesOnly: true, failures, databaseCount: 2 };
  record.status = failures.length || record.status === "failed" ? "failed" : "cleaned";
  for (const button of controls) button.disabled = true;
  await publish(); note(failures.length ? "隔离库清理失败，请查看记录" : "两个隔离数据库已清理；未操作真实书库");
}
try {
  const response = await fetch("/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!response.ok) throw new Error(await response.text());
  run = await response.json(); record.runId = run.runId;
  record.boundaries = ["Frozen complete views/storage source; only persistence import and DB names substituted", "Synthetic localhost API and native export responses", "No actual Android WebView, SAF, disk pressure, real books, or installed app"];
  wrapDatabases();
  for (const file of ["css/base.css", "modules/novels/styles.css"]) {
    const link = document.createElement("link"); link.rel = "stylesheet"; link.href = "/run/" + run.runId + "/android-client/" + file; document.head.append(link);
  }
  window.Capacitor = { Plugins: { FanHaoNovel: {
    setReaderImmersive: async () => {}, clearReaderBrightness: async () => {}, setReaderBrightness: async () => {},
    async exportTextFile({ fileName, text }) {
      state.saveCalls++; state.refresh();
      record.events.push({ action: "native-export-request", mode: state.saveMode, fileName });
      if (state.saveMode === "cancel") return { canceled: true };
      if (state.saveMode === "fail") throw new Error("合成保存失败");
      record.exports.push({ fileName, bytes: new Blob([text]).size, text, sha256: await digest(text) });
      return { fileName };
    }
  } } };
  await seed();
  const { createNovelViews } = await import("/run/" + run.runId + "/android-client/modules/novels/novel-views.js");
  const els = { viewKicker: byId("kicker"), viewTitle: byId("title"), viewMeta: byId("meta"), viewContent: byId("view") };
  views = createNovelViews({
    els, getActiveUrl: () => location.origin, showView, goBack: () => showView("novels"),
    setActiveBottom() {}, renderCurrentView: () => showView(route.view, route.params),
    renderCurrentViewPreservingScroll: () => showView(route.view, route.params),
    setStatus(text) { record.events.push({ action: "status", text: String(text) }); note(text); }
  });
  bind("library", () => showView("novels"));
  bind("detail", () => showView("novelDetail", { id: "local:recovery-fixture:01" }));
  bind("reader", () => showView("novelReader", { id: "local:recovery-fixture:01", chapterIndex: 1 }));
  bind("leave", () => showView("tools"));
  bind("hold-list", () => { state.holdList = true; note("旧库列表结果将延迟交给页面"); });
  bind("release-list", () => { state.holdList = false; state.listReleases.splice(0).forEach(resolve => resolve()); note("已释放旧库列表"); });
  bind("hold-entry", () => { state.holdEntry = true; note("旧库正文结果将延迟交给页面"); });
  bind("release-entry", () => { state.holdEntry = false; state.entryReleases.splice(0).forEach(resolve => resolve()); note("已释放旧库正文"); });
  for (const [id, mode] of [["save-ok", "ok"], ["save-cancel", "cancel"], ["save-fail", "fail"]]) bind(id, () => { state.saveMode = mode; note("合成保存模式：" + mode); });
  for (const [id, theme] of [["theme-light", "light"], ["theme-dark", "dark"]]) bind(id, () => {
    document.documentElement.dataset.theme = theme;
    note("测试主题：" + (theme === "light" ? "浅色" : "深色"));
  });
  bind("inspect", inspect); bind("cleanup", cleanup);
  for (const button of controls) button.disabled = false;
  record.status = "ready"; await publish(); note("已准备14本合成旧书；尚未发起恢复列表或正文请求");
  byId("title").textContent = "等待打开测试页面";
} catch (error) {
  record.status = "failed"; record.errors.push(String(error.stack || error)); note("夹具初始化失败：" + error.message);
  if (record.runId) await publish();
}
