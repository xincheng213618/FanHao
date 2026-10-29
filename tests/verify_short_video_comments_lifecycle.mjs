import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createShortVideoCommentsView } from "../public/modules/short-videos/comments-view.js";

// Actual comments module with controlled native events, focus, requests and
// timers. No server, downloader, database or user comments are accessed.
class Element extends EventTarget {
  constructor(tag, metrics) {
    super(); this.tagName = tag.toUpperCase(); this.metrics = metrics; this.children = []; this.attributes = new Map();
    this.parentElement = null; this.className = ""; this.ownText = ""; this.value = ""; this.scrollTop = 0;
    this.dataset = new Proxy({}, { set: (object, key, value) => { metrics.writes++; object[key] = value; return true; } });
    this.style = new Proxy({}, { set: (object, key, value) => { metrics.writes++; object[key] = value; return true; } });
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        metrics.writes++;
        const names = new Set(this.className.split(/\s+/).filter(Boolean)), active = force ?? !names.has(name);
        if (active) names.add(name); else names.delete(name);
        this.className = [...names].join(" "); return active;
      }
    };
  }
  get isConnected() { return this.connected || Boolean(this.parentElement?.isConnected); }
  get textContent() { return this.ownText + this.children.map(node => node.textContent).join(""); }
  set textContent(value) {
    this.metrics.writes++; this.children.forEach(node => { node.parentElement = null; }); this.children = []; this.ownText = String(value);
  }
  set innerHTML(value) { assert.equal(value, ""); this.textContent = value; }
  setAttribute(name, value) { this.metrics.writes++; this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.metrics.writes++; this.attributes.delete(name); }
  append(...nodes) { nodes.forEach(node => { node.remove(); node.parentElement = this; this.children.push(node); this.metrics.writes++; }); }
  remove() { if (this.parentElement) { this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; this.metrics.writes++; } }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith(".") ? node.classList.contains(selector.slice(1)) : node.tagName.toLowerCase() === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { if (this.isConnected) { this.metrics.focuses.push(this); document.activeElement = this; } }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click", { cancelable: true })); }
  requestSubmit() { this.dispatchEvent(new Event("submit", { cancelable: true })); }
}
const settle = async () => { for (let turn = 0; turn < 16; turn++) await Promise.resolve(); };
const comment = (id, body = id) => ({ id, body, createdAt: "2026-10-27T00:00:00Z" });

function fixture({ factory = createShortVideoCommentsView, defaultOwner = false, current = true, copy = null } = {}) {
  const metrics = { created: 0, writes: 0, focuses: [] }, requests = [], toasts = [], external = [], timers = new Map();
  let sequence = 0;
  globalThis.document = {
    activeElement: null,
    createElement: tag => { metrics.created++; return new Element(tag, metrics); },
    createTextNode: text => { const node = new Element("#text", metrics); node.textContent = text; return node; }
  };
  globalThis.window = {
    setTimeout(callback, delay) { const id = sequence++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  const root = new Element("root", metrics), panel = new Element("section", metrics); root.connected = true; root.append(panel);
  const owner = { current };
  const render = factory({
    api(path, options = {}) {
      let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      // The request deliberately remains settleable after abort to verify that
      // ownership also protects adapters which do not honor cancellation.
      requests.push({ path, options, resolve, reject, promise }); return promise;
    },
    copyShortVideoValue: copy || (async (...args) => external.push(["copy", ...args])),
    createIcon: () => new Element("i", metrics), formatCompact: String, formatLocalCommentDate: String, formatNumber: String,
    localShortVideoUrl: () => "/fixture/local", openDouyinLink: video => external.push(["open", video.id]),
    originalDouyinUrl: () => "/fixture/original", showBrowserToast: value => toasts.push(value)
  });
  const wrap = defaultOwner ? render({ id: "A" }) : render({ id: "A" }, {
    isCurrent: () => owner.current && panel.isConnected && panel.dataset.closing !== "1"
  });
  panel.append(wrap);
  const textarea = wrap.querySelector("textarea"), form = wrap.querySelector("form");
  const sync = wrap.querySelector(".short-video-comments-remote-actions").children[0];
  const submit = form.querySelector("button");
  const localIds = () => wrap.querySelectorAll(".short-video-local-comment").filter(node => !node.classList.contains("is-remote")).map(node => node.dataset.commentId);
  const remoteText = () => wrap.querySelector(".short-video-remote-comment-list").textContent;
  const snapshot = () => ({ created: metrics.created, writes: metrics.writes, focuses: metrics.focuses.length,
    toasts: [...toasts], requests: requests.length, value: textarea.value, localIds: localIds(), remote: remoteText() });
  const post = (value = "new draft") => { textarea.value = value; textarea.dispatchEvent(new Event("input")); form.requestSubmit(); };
  const close = () => { wrap.shortVideoDisposeComments(); panel.remove(); };
  const externalFocus = () => { const node = new Element("input", metrics); root.append(node); node.focus(); return node; };
  return { root, panel, owner, wrap, textarea, form, sync, submit, metrics, requests, toasts, external, timers,
    localIds, remoteText, snapshot, post, close, externalFocus };
}

async function assertLateReadIsSilent(factory = createShortVideoCommentsView) {
  for (const completion of ["resolve", "reject"]) {
    for (const invalidate of [f => f.close(), f => f.wrap.remove(), f => { f.owner.current = false; }, f => { f.panel.dataset.closing = "1"; }]) {
      const f = fixture({ factory }); assert.equal(f.requests.length, 1);
      invalidate(f); f.externalFocus(); const before = f.snapshot();
      f.requests[0][completion](completion === "resolve" ? { comments: [comment("late")], remoteComments: [comment("remote")] } : new Error("late failure"));
      await settle(); assert.deepEqual(f.snapshot(), before, "late read cannot render or toast after view ownership ends");
      f.close();
    }
  }
}
await assertLateReadIsSilent();

async function assertNewMutationSurvivesOldRead(factory = createShortVideoCommentsView) {
  const f = fixture({ factory }); f.textarea.focus(); f.post();
  f.requests[1].resolve({ comment: comment("new"), comments: [comment("new")] }); await settle();
  assert.deepEqual(f.localIds(), ["new"], "a successful post becomes visible before the initial read finishes");
  f.requests[0].resolve({ comments: [comment("old")], remoteComments: [comment("remote")] }); await settle();
  assert.deepEqual(f.localIds(), ["new"], "an older read cannot overwrite a successful local mutation");
  assert.match(f.remoteText(), /remote/, "the read can still initialize independent remote comments");
  f.close();
}
await assertNewMutationSurvivesOldRead();

{
  const f = fixture(); f.sync.click();
  f.requests[1].resolve({ remoteComments: [comment("synced")], imported: 1 }); await settle();
  assert.match(f.remoteText(), /synced/);
  f.requests[0].resolve({ comments: [comment("local")], remoteComments: [comment("stale-remote")] }); await settle();
  assert.match(f.remoteText(), /synced/); assert.doesNotMatch(f.remoteText(), /stale-remote/);
  assert.deepEqual(f.localIds(), ["local"], "remote sync does not suppress the independent local read");
  f.close();
}

{
  const f = fixture(); f.requests[0].reject(new Error("retryable")); await settle();
  const retry = f.wrap.querySelector(".short-video-local-comments-status").querySelector("button"); retry.click();
  f.post(); f.requests[2].resolve({ comment: comment("new"), comments: [comment("new"), comment("keep")] }); await settle();
  const remove = f.wrap.querySelector(".short-video-local-comment-delete"); remove.click(); remove.click();
  assert.equal(f.requests[3].options.method, "DELETE"); f.requests[3].resolve({ comments: [comment("keep")] }); await settle();
  f.requests[1].resolve({ comments: [comment("new"), comment("stale")] }); await settle();
  assert.deepEqual(f.localIds(), ["keep"], "a pending retry cannot restore comments deleted by a newer mutation");
  f.close();
}

async function assertConcurrentPostKeepsDeletion(factory = createShortVideoCommentsView) {
  for (const deleteFirst of [true, false]) {
    const f = fixture({ factory }); f.requests[0].resolve({ comments: [comment("A"), comment("B")] }); await settle();
    f.post("C"); const remove = f.wrap.querySelector(".short-video-local-comment-delete"); remove.click(); remove.click();
    const postReply = { comment: comment("C"), comments: [comment("C"), comment("A"), comment("B")] };
    const deleteReply = { deletedId: "A", comments: [comment("C"), comment("B")] };
    if (deleteFirst) {
      f.requests[2].resolve(deleteReply); await settle();
      assert.deepEqual(f.localIds(), ["B"], "a delete patches its own item while the independent post awaits acknowledgement");
      f.requests[1].resolve(postReply);
    } else {
      f.requests[1].resolve(postReply); await settle(); f.requests[2].resolve(deleteReply);
    }
    await settle();
    assert.deepEqual(f.localIds(), ["C", "B"], "a late post cannot resurrect a concurrently deleted comment");
    assert.equal(f.toasts.length, 2, "both successful user operations are acknowledged"); f.close();
  }
}
await assertConcurrentPostKeepsDeletion();

async function assertConcurrentDeletesKeepBothResults(factory = createShortVideoCommentsView) {
  for (const reverse of [true, false]) {
    const f = fixture({ factory }); f.requests[0].resolve({ comments: [comment("A"), comment("B")] }); await settle();
    const [a, b] = f.wrap.querySelectorAll(".short-video-local-comment-delete"); a.click(); a.click(); b.click(); b.click();
    const replies = [{ deletedId: "A", comments: [comment("B")] }, { deletedId: "B", comments: [] }];
    const first = reverse ? 1 : 0, last = 1 - first;
    f.requests[first + 1].resolve(replies[first]); await settle();
    assert.deepEqual(f.localIds(), [reverse ? "A" : "B"], "each response removes only its acknowledged item");
    f.requests[last + 1].resolve(replies[last]); await settle();
    assert.deepEqual(f.localIds(), [], "out-of-order delete snapshots cannot resurrect another deleted comment");
    assert.equal(f.toasts.length, 2); f.close();
  }
}
await assertConcurrentDeletesKeepBothResults();

for (const completion of ["resolve", "reject"]) {
  const f = fixture(); f.requests[0].resolve({ comments: [comment("A"), comment("B")] }); await settle();
  const [a, b] = f.wrap.querySelectorAll(".short-video-local-comment-delete"); a.click(); a.click(); b.click(); b.click();
  f.requests[1].resolve({ deletedId: "A", comments: [comment("B")] }); await settle();
  const currentB = f.wrap.querySelector(".short-video-local-comment-delete");
  assert.notEqual(currentB, b); assert.equal(currentB.disabled, true); assert.equal(currentB.getAttribute("aria-busy"), "true");
  currentB.dispatchEvent(new Event("click")); currentB.dispatchEvent(new Event("click"));
  assert.equal(f.requests.length, 3, "a rerendered delete control cannot issue another request for the same pending item");
  f.requests[2][completion](completion === "resolve" ? { deletedId: "B", comments: [] } : new Error("B delete failed")); await settle();
  if (completion === "resolve") assert.deepEqual(f.localIds(), []);
  else {
    assert.deepEqual(f.localIds(), ["B"]); assert.equal(currentB.disabled, false);
    assert.equal(currentB.getAttribute("aria-busy"), null); assert.equal(currentB.dataset.confirm, "0");
    currentB.click(); currentB.click(); assert.equal(f.requests.length, 4, "a failed operation releases the current control for retry");
    f.requests[3].resolve({ deletedId: "B", comments: [] }); await settle(); assert.deepEqual(f.localIds(), []);
  }
  f.close();
}

async function assertExposedPendingPostCanStayDeleted(factory = createShortVideoCommentsView) {
  const f = fixture({ factory }); f.post("C");
  // The server has inserted C, but the post response is delayed while a read
  // exposes C and the user deletes it. Both server operations still succeed.
  f.requests[0].resolve({ comments: [comment("C"), comment("A")] }); await settle();
  const remove = f.wrap.querySelector(".short-video-local-comment-delete"); remove.click(); remove.click();
  f.requests[2].resolve({ deletedId: "C", comments: [comment("A")] }); await settle();
  f.requests[1].resolve({ comment: comment("C"), comments: [comment("C"), comment("A")] }); await settle();
  assert.deepEqual(f.localIds(), ["A"], "a posted item exposed by a read and then deleted cannot return with its delayed post response");
  assert.equal(f.toasts.length, 2); f.close();
}
await assertExposedPendingPostCanStayDeleted();

{
  const f = fixture(); f.requests[0].resolve({ comments: [comment("A"), comment("B")] }); await settle(); f.post("C");
  const [a, b] = f.wrap.querySelectorAll(".short-video-local-comment-delete"); a.click(); a.click(); b.click(); b.click();
  f.requests[3].resolve({ deletedId: "B", comments: [comment("C")] }); await settle();
  f.requests[2].resolve({ deletedId: "A", comments: [comment("C"), comment("B")] }); await settle();
  f.requests[1].resolve({ comment: comment("C"), comments: [comment("C"), comment("A"), comment("B")] }); await settle();
  assert.deepEqual(f.localIds(), ["C"], "a pending post preserves all independently completed deletions");
  f.close();
}
{
  const f = fixture(); f.requests[0].resolve({ comments: [comment("A")] }); await settle(); f.post("C");
  const remove = f.wrap.querySelector(".short-video-local-comment-delete"); remove.click(); remove.click();
  f.requests[2].reject(new Error("delete failed")); await settle();
  f.requests[1].resolve({ comment: comment("C"), comments: [comment("C"), comment("A")] }); await settle();
  assert.deepEqual(f.localIds(), ["C", "A"], "an unsuccessful deletion cannot suppress a comment in a successful post");
  f.close();
}

for (const kind of ["post", "delete", "sync"]) {
  for (const completion of ["resolve", "reject"]) {
    for (const closing of [false, true]) {
      const f = fixture(); f.requests[0].resolve({ comments: [comment("existing")] }); await settle();
      if (kind === "post") f.post();
      if (kind === "sync") f.sync.click();
      if (kind === "delete") { const remove = f.wrap.querySelector(".short-video-local-comment-delete"); remove.click(); remove.click(); }
      assert.equal(f.requests.length, 2);
      if (closing) f.panel.dataset.closing = "1"; else f.close();
      const focused = f.externalFocus(), before = f.snapshot();
      f.requests[1][completion](completion === "resolve" ? { comments: [comment("late")], remoteComments: [comment("late-remote")] } : new Error("late failure"));
      await settle(); assert.deepEqual(f.snapshot(), before, `${kind} ${completion} cannot update a closed/closing view`);
      assert.equal(document.activeElement, focused); f.close();
    }
  }
}

async function assertFocusRemainsWithUser(factory = createShortVideoCommentsView) {
  const f = fixture({ factory }); f.requests[0].resolve({ comments: [] }); await settle();
  f.textarea.focus(); f.post(); const other = f.externalFocus();
  f.requests[1].resolve({ comments: [comment("saved")] }); await settle();
  assert.equal(document.activeElement === other, true, "late submit cannot steal the user's new focus");
  assert.equal(f.textarea.value, ""); assert.deepEqual(f.localIds(), ["saved"]); f.close();
}
await assertFocusRemainsWithUser();

{
  const f = fixture(); f.requests[0].resolve({ comments: [] }); await settle();
  f.submit.focus(); f.post(); f.requests[1].resolve({ comments: [comment("saved")] }); await settle();
  assert.equal(document.activeElement, f.textarea, "normal completed submission returns focus from its own send control");
  f.textarea.focus(); f.post("submitted"); f.textarea.value = "next draft";
  f.requests[2].resolve({ comments: [comment("again")] }); await settle();
  assert.equal(f.textarea.value, "next draft", "typing during the pending save preserves the next draft");
  assert.equal(f.submit.disabled, false); f.close();
}
{
  const f = fixture(); f.requests[0].resolve({ comments: [] }); await settle(); f.textarea.focus(); f.post("retry draft");
  f.requests[1].reject(new Error("save failed")); await settle();
  assert.equal(f.textarea.value, "retry draft"); assert.equal(f.submit.disabled, false);
  assert.equal(document.activeElement, f.textarea); assert.match(f.toasts.at(-1), /save failed/); f.close();
}

for (const action of ["dispose", "rerender", "timeout"]) {
  const f = fixture(); f.requests[0].resolve({ comments: [comment("existing")] }); await settle();
  const remove = f.wrap.querySelector(".short-video-local-comment-delete"); remove.click();
  assert.equal(f.timers.size, 1); assert(f.timers.has(0), "timer handle zero is valid");
  const callback = f.timers.get(0).callback;
  if (action === "dispose") f.wrap.shortVideoDisposeComments();
  if (action === "rerender") { f.post(); f.requests[1].resolve({ comments: [comment("new")] }); await settle(); }
  if (action === "timeout") { f.timers.delete(0); callback(); }
  assert.equal(f.timers.size, 0, `${action} releases confirmation timers`);
  if (action === "timeout") { assert.equal(remove.dataset.confirm, "0"); assert.equal(remove.textContent, "删除"); }
  else {
    const before = f.snapshot(); callback(); assert.deepEqual(f.snapshot(), before, "an already queued canceled timer cannot write stale nodes");
    remove.dispatchEvent(new Event("click")); await settle(); assert.deepEqual(f.snapshot(), before, "old remove buttons cannot issue a mutation");
  }
  f.close();
}

{
  const f = fixture(); assert.equal(f.requests[0].options.signal.aborted, false);
  f.wrap.shortVideoDisposeComments(); assert.equal(f.requests[0].options.signal.aborted, true);
  f.wrap.shortVideoDisposeComments(); const before = f.snapshot();
  f.post(); f.sync.dispatchEvent(new Event("click"));
  const actions = f.wrap.querySelector(".short-video-comments-remote-actions");
  actions.children[1].dispatchEvent(new Event("click")); actions.children[2].dispatchEvent(new Event("click"));
  await settle();
  assert.equal(f.requests.length, before.requests); assert.equal(f.external.length, 0); assert.equal(f.toasts.length, 0); f.close();
}
{
  const f = fixture({ current: false }); assert.equal(f.requests.length, 0, "an invalid owner does not start the initial request"); f.close();
}
{
  const f = fixture({ defaultOwner: true }); f.requests[0].resolve({ comments: [comment("normal")] }); await settle();
  assert.deepEqual(f.localIds(), ["normal"], "the existing single-argument API keeps working");
  f.sync.click(); assert.equal(f.requests[1].options.method, "POST");
  f.requests[1].resolve({ remoteComments: [comment("normal-remote")] }); await settle(); assert.match(f.remoteText(), /normal-remote/); f.close();
}

// Compose the actual comments click handler with the shared clipboard helper;
// an immediate copy stub cannot expose its asynchronous toast/fallback path.
const actionsSource = fs.readFileSync(new URL("../public/modules/short-videos/actions-controller.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const copyStart = actionsSource.indexOf("  async function copyShortVideoValue("), copyEnd = actionsSource.indexOf("\n  }", copyStart) + 4;
assert(copyStart >= 0 && copyEnd > copyStart);
for (const completion of ["resolve", "reject"]) {
  for (const invalidate of [f => f.close(), f => { f.panel.dataset.closing = "1"; }, f => f.wrap.remove()]) {
    let resolve, reject;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    const copyToasts = [], fallbacks = [], clipboardWrites = [];
    const realCopy = vm.runInNewContext(`${actionsSource.slice(copyStart, copyEnd)}\ncopyShortVideoValue;`, {
      navigator: { clipboard: { writeText(value) { clipboardWrites.push(value); return pending; } } },
      window: { setTimeout: () => 0 }, showToast: value => copyToasts.push(value), fallbackCopyText: value => fallbacks.push(value)
    });
    const f = fixture({ copy: realCopy });
    f.wrap.querySelector(".short-video-comments-remote-actions").children[2].click();
    assert.deepEqual(clipboardWrites, ["/fixture/original"]);
    invalidate(f); const focused = f.externalFocus(), before = f.snapshot();
    if (completion === "resolve") resolve(); else reject(new Error("late clipboard failure"));
    await settle();
    assert.deepEqual(copyToasts, [], `${completion}: an obsolete copy never emits success/error feedback`);
    assert.deepEqual(fallbacks, [], `${completion}: an obsolete copy never starts the focus-changing fallback`);
    assert.deepEqual(f.snapshot(), before); assert.equal(document.activeElement, focused); f.close();
  }
}

// Execute deliberately weakened copies in memory. The real regressions must
// fail when lifetime, data-order or focus ownership checks are removed.
const source = fs.readFileSync(new URL("../public/modules/short-videos/comments-view.js", import.meta.url), "utf8");
async function negative(before, after, run, pattern) {
  const changed = source.replace(before, after); assert.notEqual(changed, source);
  const { createShortVideoCommentsView: factory } = await import(`data:text/javascript;base64,${Buffer.from(changed).toString("base64")}`);
  await assert.rejects(run(factory), pattern);
}
await negative("const ownsView = () => !disposed && wrap.isConnected && isCurrent();", "const ownsView = () => true;",
  assertLateReadIsSilent, /late read cannot render or toast/);
await negative("if (localRevision === localMutationRevision) {", "if (true) {",
  assertNewMutationSurvivesOldRead, /older read cannot overwrite/);
await negative("if (document.activeElement === focusOwner && composer.contains(focusOwner) && focusOwner !== textarea) textarea.focus();", "textarea.focus();",
  assertFocusRemainsWithUser, /late submit cannot steal/);
await negative("comments = comments.filter(itemComment => String(itemComment.id || \"\") !== deletedId);", "comments = data.comments;",
  assertConcurrentDeletesKeepBothResults, /each response removes only|out-of-order delete snapshots/);
await negative("for (const post of pendingCommentPosts) post.deletedIds.add(deletedId);", "// deleted IDs no longer invalidate pending post snapshots",
  assertExposedPendingPostCanStayDeleted, /posted item exposed by a read and then deleted/);

delete globalThis.document; delete globalThis.window;
console.log("short-video-comments-lifecycle: passed actual disposal/cancellation, stale reads and concurrent post/delete ownership, confirmation cleanup, draft/focus preservation and negative controls");
