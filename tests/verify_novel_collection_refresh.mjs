import assert from "node:assert/strict";
import { createNovelCollectionAdmin } from "../public/modules/novels/collection-admin.js";

// Actual client controller and its rendered submit handler; synthetic API/DOM only.
const previousWindow = globalThis.window;
const previousDocument = globalThis.document;

class Element {
  children = [];
  events = new Map();
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  addEventListener(name, callback) { this.events.set(name, callback); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function findButton(element, label) {
  if (element.textContent === label && element.events.has("click")) return element;
  for (const child of element.children) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
}

function fixture() {
  const reads = [];
  const timers = new Map();
  let timerId = 0;
  let active = true;
  let reading = 0;
  let maxReading = 0;
  let renders = 0;
  let libraryChanges = 0;
  let writes = 0;
  let synchronousFailure = null;
  globalThis.window = {
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  };
  globalThis.document = { createElement: () => new Element() };
  const state = { novel: { mode: "manage" } };
  const admin = createNovelCollectionAdmin({
    state,
    formatNumber: String,
    formatDateTime: String,
    isActive: () => active,
    rerender: () => { renders += 1; },
    onLibraryChanged: () => { libraryChanges += 1; },
    api: (url, options = {}) => {
      if (options.method === "POST") {
        assert.equal(url, "/api/novels/collection/tasks");
        assert.equal(options.body.url, "https://synthetic.invalid/book");
        writes += 1;
        return Promise.resolve({ task: { id: "new-task", status: "queued" } });
      }
      assert.equal(url, "/api/novels/collection");
      if (synchronousFailure) {
        const error = synchronousFailure;
        synchronousFailure = null;
        throw error;
      }
      const read = deferred();
      reads.push({
        resolve(value) { reading -= 1; read.resolve(value); },
        reject(error) { reading -= 1; read.reject(error); }
      });
      maxReading = Math.max(maxReading, ++reading);
      return read.promise;
    }
  });
  const collection = admin.ensureState();
  collection.loaded = true;
  collection.runtime = { ready: true };
  collection.draftUrl = "https://synthetic.invalid/book";
  return {
    admin, collection, reads, timers,
    get maxReading() { return maxReading; },
    get renders() { return renders; },
    get libraryChanges() { return libraryChanges; },
    get writes() { return writes; },
    failNextReadSynchronously() { synchronousFailure = new Error("synchronous request failure"); },
    leave() { active = false; admin.stopPolling(); },
    enter() { active = true; },
    submit() {
      const button = findButton(admin.render(), "开始采集");
      assert(button && !button.disabled, "the actual collection form must allow submission");
      return button.events.get("click")();
    }
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const queued = { tasks: [{ id: "new-task", status: "queued" }] };

try {
  {
    const f = fixture();
    const first = f.admin.load({ silent: true });
    assert.equal(f.admin.load({ silent: true }), first, "ordinary reads must share the pending promise");
    await tick();
    f.reads[0].resolve({ tasks: [] });
    await first;
    assert.equal(f.reads.length, 1, "ordinary reads must not queue an extra GET");
    assert.equal(f.collection.loading, false);
  }

  for (const obsoleteFails of [false, true]) {
    const f = fixture();
    const first = f.admin.load({ silent: true });
    await tick();
    const submitted = f.submit();
    await tick();
    assert.equal(f.writes, 1, "the rendered form must perform the real controller mutation");
    assert.equal(f.reads.length, 1, "a mutation must queue its refresh without a parallel GET");
    assert.equal(f.collection.submitting, true, "submission must await its fresh snapshot");
    if (obsoleteFails) f.reads[0].reject(new Error("obsolete request failed"));
    else f.reads[0].resolve({ tasks: [], runtime: { ready: false } });
    await tick();
    assert.equal(f.reads.length, 2, "mutation refresh must run even if the obsolete read failed");
    assert.equal(f.collection.runtime.ready, true, "obsolete snapshots must not overwrite current state");
    assert.equal(f.collection.error, "", "obsolete errors must not replace the pending refresh");
    f.reads[1].resolve(queued);
    await Promise.all([first, submitted]);
    assert.equal(f.collection.tasks[0].id, "new-task");
    assert.equal(f.collection.selectedTaskId, "new-task");
    assert.equal(f.collection.submitting, false);
    assert.equal(f.collection.loading, false);
    assert.equal(f.timers.size, 1, "new active tasks must resume polling");
    assert.equal(f.maxReading, 1);
    f.leave();
  }

  {
    const f = fixture();
    const first = f.admin.load({ silent: true });
    await tick();
    assert.equal(f.admin.load({ silent: true, refresh: true }), first);
    assert.equal(f.admin.load({ silent: true, refresh: true }), first);
    f.reads[0].resolve({ tasks: [] });
    await tick();
    assert.equal(f.reads.length, 2, "a burst of mutation refreshes must coalesce");
    assert.equal(f.admin.load({ silent: true, refresh: true }), first);
    f.reads[1].resolve({ tasks: [{ id: "obsolete-task", status: "queued" }] });
    await tick();
    assert.equal(f.reads.length, 3, "a write during the follow-up read needs another fresh snapshot");
    assert.equal(f.collection.tasks.length, 0);
    f.reads[2].resolve(queued);
    await first;
    assert.equal(f.collection.tasks[0].id, "new-task");
    assert.equal(f.maxReading, 1);
    f.leave();
  }

  {
    const f = fixture();
    const pending = f.admin.load({ silent: true });
    await tick();
    const refresh = f.admin.load({ refresh: true });
    assert.equal(refresh, pending);
    f.reads[0].resolve({ tasks: [] });
    await tick();
    f.reads[1].resolve({ tasks: [], adapters: [{ id: "new-adapter" }] });
    await refresh;
    assert.equal(f.collection.adapters[0].id, "new-adapter");
    assert.equal(f.renders, 1, "a visible refresh joining a silent read must retain its render request");
    assert.equal(f.maxReading, 1);
  }

  {
    const f = fixture();
    const failed = f.admin.load({ silent: true });
    await tick();
    f.reads[0].reject(new Error("current request failed"));
    await failed;
    assert.equal(f.collection.error, "current request failed");
    assert.equal(f.collection.loading, false);
    const retry = f.admin.load({ silent: true });
    await tick();
    f.reads[1].resolve({ tasks: [] });
    await retry;
    assert.equal(f.collection.error, "");
    assert.equal(f.reads.length, 2, "failure must release the pending request for retry");
  }

  {
    const f = fixture();
    const first = f.admin.load({ silent: true });
    await tick();
    f.reads[0].resolve({ tasks: [] });
    await Promise.resolve();
    const fresh = f.admin.load({ silent: true, refresh: true });
    await tick();
    assert.equal(f.reads.length, 2, "refresh at the response-completion microtask must not be lost");
    f.reads[1].resolve(queued);
    await Promise.all([first, fresh]);
    assert.equal(f.collection.tasks[0].id, "new-task");
    assert.equal(f.maxReading, 1);
    f.leave();
  }

  {
    const f = fixture();
    f.failNextReadSynchronously();
    await f.admin.load({ silent: true });
    assert.equal(f.collection.error, "synchronous request failure");
    assert.equal(f.collection.loading, false);
    const retry = f.admin.load({ silent: true });
    await tick();
    assert.equal(f.reads.length, 1, "a synchronous failure must not retain a completed request owner");
    f.reads[0].resolve({ tasks: [] });
    await retry;
    assert.equal(f.collection.error, "");
  }

  {
    const f = fixture();
    const pending = f.admin.load();
    await tick();
    const rendersBeforeLeaving = f.renders;
    f.leave();
    f.reads[0].resolve({ tasks: [{ id: "finished", status: "succeeded", bookId: "book" }] });
    await pending;
    assert.equal(f.renders, rendersBeforeLeaving, "a hidden management page must not render late completion");
    assert.equal(f.libraryChanges, 0, "late hidden completion must not refresh the library UI");
    assert.equal(f.timers.size, 0, "leaving management must not restart polling");
    f.enter();
    const reload = f.admin.load({ silent: true });
    await tick();
    f.reads[1].resolve(queued);
    await reload;
    assert.equal(f.timers.size, 1, "returning to management must still allow normal polling");
    f.leave();
  }
  console.log("novel-collection-refresh: ok (mutation races, serial/coalesced GETs, failure retry, navigation)");
} finally {
  globalThis.window = previousWindow;
  globalThis.document = previousDocument;
}
