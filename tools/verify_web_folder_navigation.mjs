import assert from "node:assert/strict";
import { createCollectionPage } from "../public/modules/fanhao/features/collections/collection-page.js";

// Execute the real collection page and request gate. Only DOM, dialogs and HTTP
// completion order are doubled; no browser, database or service is involved.
class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.textContent = "";
    this.disabled = false;
    this.html = "";
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  querySelectorAll(selector) {
    assert.equal(selector, "button[data-folder-mutation]", "unexpected fixture selector");
    return this.children.flatMap((child) => [
      ...(child.tag === "button" && child.dataset.folderMutation ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
  click() {
    assert.equal(this.disabled, false, "test must invoke an enabled user control");
    return this.listeners.get("click")?.();
  }
}

function fixture() {
  const requests = [], rendered = [], errors = [], alerts = [];
  const els = { statsRow: new Element(), workGrid: new Element() };
  const folders = [
    { id: "default", name: "默认收藏", count: 0 },
    { id: "folder-f", name: "收藏夹 F", count: 1 },
    { id: "folder-g", name: "收藏夹 G", count: 1 }
  ];
  const state = {
    activeView: "favorites", selectedFavoriteFolderId: "folder-f",
    selectedHistoryRange: "30", favoriteFolders: folders, works: [], workPageSize: 48
  };
  let promptResult = "修改后的收藏夹 F";
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: (tag) => new Element(tag) } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    prompt: () => promptResult,
    alert: (message) => alerts.push(message)
  } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { connection: { saveData: true } } });
  const page = createCollectionPage({
    state, els, formatNumber: String,
    api(path, options = {}) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const abort = () => reject(new DOMException("Request aborted", "AbortError"));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      requests.push({ path, options, resolve, reject });
      return promise.finally(() => options.signal?.removeEventListener("abort", abort));
    },
    appendLoadedWorkPage() {}, hidePersonProfile() {}, resetWorkPaging() {}, setMainHeader() {},
    renderStatsForWorks() { els.statsRow.innerHTML = ""; },
    renderEmpty(message) { errors.push(message); els.workGrid.innerHTML = message; },
    renderWorks() {
      rendered.push({ view: state.activeView, ids: state.works.map((work) => work.id) });
      els.workGrid.innerHTML = "已渲染作品";
    }
  });
  page.renderFavoriteFolderControls();
  return {
    page, state, els, folders, requests, rendered, errors, alerts,
    renameButton: els.statsRow.querySelectorAll("button[data-folder-mutation]").find((button) => button.dataset.folderMutation === "rename"),
    setPromptResult(value) { promptResult = value; }
  };
}

async function settled(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 1500); })
    ]);
  } finally { clearTimeout(timer); }
}

const originalGlobals = new Map(["document", "window", "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
try {
  for (const nextView of ["history", "vr"]) {
    const f = fixture();
    const mutation = f.renameButton.click();
    const rename = f.requests[0];
    assert.equal(rename.path, "/api/favorite-folders/folder-f");
    assert.equal(rename.options.method, "PATCH");

    // The user navigates while the rename is still waiting for the server.
    f.state.activeView = nextView;
    f.page.cancelPendingRequests();
    const loading = nextView === "history" ? f.page.loadHistory() : f.page.loadVrWorks();
    const read = f.requests[1];
    assert(read.path.startsWith(nextView === "history" ? "/api/history?" : "/api/works?"));
    rename.resolve({ folder: { ...f.folders[1], name: "修改后的收藏夹 F" }, folders: f.folders });
    await settled(mutation, `${nextView} rename`);
    read.resolve({ works: [{ id: `${nextView}-work` }], total: 1 });
    await settled(loading, `${nextView} navigation`);

    assert.deepEqual(f.rendered, [{ view: nextView, ids: [`${nextView}-work`] }],
      `successful folder mutation must not strand the later ${nextView} page at loading`);
    assert.equal(f.state.activeView, nextView, "mutation must preserve the user's newer navigation");
    assert.equal(f.requests.length, 2, "mutation must not reload favorites over another collection view");
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.alerts, []);
  }

  {
    const f = fixture();
    // Folder F's controls remain visible while the newly selected G is loading.
    f.state.selectedFavoriteFolderId = "folder-g";
    const loading = f.page.loadFavorites();
    const read = f.requests[0];
    assert.equal(new URL(read.path, "http://fixture.invalid").searchParams.get("folder"), "folder-g");
    f.setPromptResult("");
    const mutation = f.renameButton.click();
    const rename = f.requests[1];
    assert.equal(rename.path, "/api/favorite-folders/folder-f", "old controls must still refer to their original folder");
    assert.deepEqual(rename.options.body, { name: "" });
    rename.reject(Object.assign(new Error("收藏夹名称不能为空"), { statusCode: 400 }));
    await settled(mutation, "rejected rename");
    read.resolve({ works: [{ id: "folder-g-work" }], total: 1, selectedFolderId: "folder-g", folders: f.folders });
    await settled(loading, "favorites navigation after rejected rename");

    assert.deepEqual(f.rendered, [{ view: "favorites", ids: ["folder-g-work"] }],
      "rejected folder mutation must not strand the pending selected-folder read at loading");
    assert.equal(f.state.selectedFavoriteFolderId, "folder-g");
    assert.deepEqual(f.alerts, ["收藏夹名称不能为空"], "failed write must remain visible to the user");
    assert.deepEqual(f.errors, []);
    assert.equal(f.requests.length, 2, "a rejected mutation must not automatically retry the write");
    assert(f.els.statsRow.querySelectorAll("button[data-folder-mutation]").every((button) => !button.disabled),
      "folder management controls must become usable after the failure");
  }
  console.log("web-folder-navigation: ok (late rename preserves history/VR navigation; rejected rename preserves the pending folder read)");
} finally {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
