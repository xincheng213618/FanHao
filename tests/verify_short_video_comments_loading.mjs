import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/modules/short-videos/short-video-page.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("  function lazyShortVideoCommentsView(");
assert(start >= 0);
const implementation = source.slice(start, source.indexOf("\n  }", start) + 4);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function element() {
  const classes = new Set(), handlers = new Map();
  return {
    children: [], attributes: {}, isConnected: false, className: "", textContent: "",
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, callback) { handlers.set(name, callback); }, click() { handlers.get("click")?.(); },
    replaceChildren(...children) { this.children = children; },
    replaceWith(next) { this.isConnected = false; next.isConnected = true; this.replacement = next; }
  };
}
function fixture() {
  const pending = [], rendered = [], panel = { isConnected: true, dataset: { activeTab: "comments" } };
  const context = vm.createContext({ document: { createElement: element },
    ensureShortVideoCommentsView() { const request = deferred(); pending.push(request); return request.promise; }
  });
  vm.runInContext(`${implementation}\nglobalThis.render=lazyShortVideoCommentsView;`, context);
  const placeholder = context.render({ id: "fixture" }, panel);
  placeholder.isConnected = true;
  const render = (video, options) => { const view = element(); view.video = video; view.options = options; view.disposeCalls = 0; view.shortVideoDisposeComments = () => view.disposeCalls++; rendered.push(view); return view; };
  return { panel, placeholder, pending, rendered, render };
}

for (const invalidation of ["closing", "disposed", "detached panel", "detached placeholder", "other tab", "explicit disposal"]) {
  for (const failure of [false, true]) {
    const f = fixture();
    if (invalidation === "closing") f.panel.dataset.closing = "1";
    if (invalidation === "disposed") f.panel.dataset.disposed = "1";
    if (invalidation === "detached panel") f.panel.isConnected = false;
    if (invalidation === "detached placeholder") f.placeholder.isConnected = false;
    if (invalidation === "other tab") f.panel.dataset.activeTab = "works";
    if (invalidation === "explicit disposal") f.placeholder.shortVideoDisposeComments();
    if (failure) f.pending[0].reject(new Error("late module error")); else f.pending[0].resolve(f.render);
    await settle();
    assert.equal(f.rendered.length, 0, `${invalidation}: late module cannot create comments or issue a comments GET`);
    assert.equal(f.placeholder.children.length, 0, `${invalidation}: late failure cannot paint a retry UI`);
  }
}
{
  const f = fixture(); f.pending[0].resolve(f.render); await settle();
  assert.equal(f.rendered.length, 1);
  assert.equal(f.placeholder.replacement, f.rendered[0]);
  assert.equal(f.rendered[0].options.isCurrent(), true);
  f.panel.dataset.closing = "1";
  assert.equal(f.rendered[0].options.isCurrent(), false, "the mounted view shares the panel's lifetime, including its closing animation");
  f.placeholder.shortVideoDisposeComments(); f.placeholder.shortVideoDisposeComments();
  assert.equal(f.rendered[0].disposeCalls, 1, "disposing a retained placeholder releases the mounted view once");
}
{
  const f = fixture(); f.pending[0].reject(new Error("module unavailable")); await settle();
  assert.equal(f.placeholder.children[0].textContent, "module unavailable");
  const retry = f.placeholder.children[1];
  retry.click(); retry.click();
  assert.equal(f.pending.length, 3);
  f.pending[2].resolve(f.render); await settle();
  f.pending[1].resolve(f.render); await settle();
  assert.equal(f.rendered.length, 1, "shared downloads and repeated retry clicks produce one current mount");
}
{
  const f = fixture(); f.pending[0].reject(new Error("module unavailable")); await settle();
  const retry = f.placeholder.children[1];
  f.placeholder.shortVideoDisposeComments();
  f.panel.dataset.activeTab = "works"; f.panel.dataset.activeTab = "comments";
  retry.click();
  assert.equal(f.pending.length, 1, "an old retry cannot reopen a disposed comments tab after an ABA tab switch");
}
console.log("short-video-comments-loading: actual lazy module mount/retry honors closing, disposal, tab ownership and current request generations");
