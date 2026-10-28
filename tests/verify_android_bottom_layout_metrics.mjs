import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// The complete production helper runs with deterministic DOM border boxes,
// lifecycle events, ResizeObserver delivery and RAF. No shell, service, browser,
// native inset source or actual media/database is accessed.
const helperUrl = new URL("../android-client/www/js/bottom-layout.js", import.meta.url);
const helperSource = fs.readFileSync(helperUrl, "utf8").replace(/\r\n/g, "\n");
const { installBottomLayout } = await import(helperUrl.href);
const HEIGHT = "--fanhao-bottom-nav-height";

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      const entries = listeners.get(type) || new Set(); entries.add(callback); listeners.set(type, entries);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type, values = {}) { for (const callback of [...listeners.get(type) || []]) callback({ type, ...values }); },
    listenerCount() { return [...listeners.values()].reduce((count, entries) => count + entries.size, 0); }
  };
}

function fixture(install = installBottomLayout, { observer = true, hidden = false, height = 87.5, initialHeight = null } = {}) {
  const frames = new Map(), observers = [], properties = new Map(), writes = [], stats = { reads: 0 };
  const geometry = { height }, lifecycle = events(); let frameId = 0;
  if (initialHeight !== null) properties.set(HEIGHT, initialHeight);
  const root = { style: {
    setProperty(name, value) { properties.set(name, String(value)); writes.push({ name, value: String(value) }); },
    getPropertyValue(name) { return properties.get(name) || ""; },
    removeProperty(name) { const previous = properties.get(name) || ""; properties.delete(name); writes.push({ name, value: "" }); return previous; }
  } };
  const nav = { hidden, isConnected: true, clientHeight: 86.5, scrollHeight: 3000,
    getBoundingClientRect() {
      stats.reads++; return { height: nav.hidden || !nav.isConnected ? 0 : geometry.height, width: 320, top: 500, bottom: 500 + geometry.height };
    },
    getClientRects() { return nav.hidden || !nav.isConnected ? [] : [{ height: geometry.height, width: 320 }]; }
  };
  class ResizeObserverDouble {
    constructor(callback) { this.callback = callback; this.active = false; this.targets = []; observers.push(this); }
    observe(target, options) { this.active = true; this.targets.push({ target, options }); }
    unobserve() { this.active = false; }
    disconnect() { this.active = false; }
    emit(entries = [{ target: nav, contentRect: { height: 44 }, borderBoxSize: [{ blockSize: geometry.height }] }]) {
      // Deliberately deliver disconnected observers too. The real helper must
      // retire callbacks that the platform had already queued before cleanup.
      this.callback(entries, this);
    }
  }
  const view = { ...lifecycle, ResizeObserver: observer ? ResizeObserverDouble : undefined,
    requestAnimationFrame(callback) { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle(target) { return { display: target.hidden ? "none" : "grid", visibility: "visible" }; }
  };
  const document = { documentElement: root, defaultView: view }; view.document = document;
  nav.ownerDocument = document; root.ownerDocument = document;
  const controller = install({ nav, root, view });
  return { nav, root, view, controller, geometry, frames, observers, writes, stats,
    value: () => root.style.getPropertyValue(HEIGHT),
    heightWrites: () => writes.filter(write => write.name === HEIGHT),
    installAgain: () => install({ nav, root, view }),
    flush() { const ready = [...frames.values()]; frames.clear(); ready.forEach(callback => callback(0)); return ready.length; },
    activeObservers: () => observers.filter(item => item.active)
  };
}

function height(value) { return `${value}px`; }

function assertBorderBox(install = installBottomLayout) {
  const f = fixture(install);
  try {
    f.flush();
    assert.equal(f.value(), height(87.5), "nav border box, including its safe-area padding, owns the published height");
    assert.equal(f.activeObservers().length, 1);
    assert.equal(f.observers[0].targets[0].target, f.nav);
    assert.equal(f.observers[0].targets[0].options?.box, "border-box");
    assert.notEqual(parseFloat(f.value()), f.nav.clientHeight, "client height omits the navigation border");
    assert.notEqual(parseFloat(f.value()), f.nav.scrollHeight, "absolute picker overflow is not navigation height");
    f.observers[0].emit([{ target: {}, contentRect: { height: 999 } }]);
    assert.equal(f.frames.size, 0, "a foreign ResizeObserver target cannot schedule a measurement");
  } finally { f.controller.dispose(); }
}

test("publishes the actual nav border box rather than child content or absolute picker overflow", () => assertBorderBox());

test("hidden startup preserves CSS fallback and later visible measurements retain the last positive height", () => {
  const f = fixture(installBottomLayout, { hidden: true });
  try {
    f.flush(); assert.equal(f.value(), "", "hidden initial nav must not replace the CSS fallback with zero");
    f.nav.hidden = false; f.geometry.height = 72.25; f.controller.refresh(); f.flush(); assert.equal(f.value(), height(72.25));
    f.nav.hidden = true; f.observers[0].emit(); f.flush(); assert.equal(f.value(), height(72.25));
    f.nav.hidden = false; f.geometry.height = 99; f.observers[0].emit(); f.flush(); assert.equal(f.value(), height(99));
  } finally { f.controller.dispose(); }
});

test("nonfinite zero and negative measurements never erase fallback or the last valid height", () => {
  const f = fixture(installBottomLayout, { height: NaN });
  try {
    f.flush(); assert.equal(f.value(), "");
    for (const invalid of [0, -1, Infinity, -Infinity, NaN]) {
      f.geometry.height = invalid; f.controller.refresh(); f.flush(); assert.equal(f.value(), "");
    }
    f.geometry.height = 80; f.controller.refresh(); f.flush();
    for (const invalid of [0, -1, Infinity, NaN]) {
      f.geometry.height = invalid; f.controller.refresh(); f.flush(); assert.equal(f.value(), height(80));
    }
  } finally { f.controller.dispose(); }
});

test("hidden startup never publishes malformed or overflowing saved inline height and recovers with a valid measurement", () => {
  for (const initialHeight of ["malformed", "0px", "-10px", `${"9".repeat(400)}px`, "70.25px"]) {
    const f = fixture(installBottomLayout, { hidden: true, initialHeight });
    try {
      f.flush(); f.controller.refresh(); f.flush();
      assert.equal(f.heightWrites().length, 0, "hidden startup cannot turn an invalid saved number into a new CSS height");
      assert.equal(f.value(), initialHeight);
      f.nav.hidden = false; f.geometry.height = 77.5; f.controller.refresh(); f.flush();
      assert.equal(f.value(), height(77.5)); assert.equal(f.heightWrites().length, 1);
    } finally { f.controller.dispose(); }
  }
});

test("manual observer and viewport signals coalesce into one frame and unchanged height creates no style writes", () => {
  const f = fixture();
  try {
    f.flush(); const writes = f.heightWrites().length, reads = f.stats.reads;
    for (let index = 0; index < 3; index++) { f.controller.refresh(); f.observers[0].emit(); f.view.emit("resize"); }
    f.view.emit("orientationchange");
    assert.equal(f.frames.size, 1, "layout signals share a single pending animation frame");
    f.flush(); assert.equal(f.stats.reads - reads, 1); assert.equal(f.heightWrites().length, writes);
    assert.equal(f.installAgain(), f.controller, "one root owns one shared bottom-layout controller");
    assert.equal(f.observers.length, 1, "duplicate installation cannot subscribe another observer");
  } finally { f.controller.dispose(); }
});

test("without ResizeObserver hidden startup manual refresh resize and orientation retain a usable height", () => {
  const f = fixture(installBottomLayout, { observer: false, hidden: true });
  try {
    f.flush(); assert.equal(f.value(), ""); assert.equal(f.observers.length, 0);
    f.nav.hidden = false; f.geometry.height = 68; f.controller.refresh(); f.flush(); assert.equal(f.value(), height(68));
    f.geometry.height = 91; f.view.emit("resize"); f.flush(); assert.equal(f.value(), height(91));
    f.geometry.height = 76; f.view.emit("orientationchange"); f.flush(); assert.equal(f.value(), height(76));
  } finally { f.controller.dispose(); }
});

test("pagehide pauses reads and old frames while BFCache pageshow reconnects and measures the current nav", () => {
  const f = fixture();
  try {
    f.flush(); const initial = f.value(), oldObserver = f.observers[0];
    f.geometry.height = 120; f.controller.refresh(); const staleFrame = [...f.frames.values()][0]; assert(staleFrame);
    f.view.emit("pagehide", { persisted: true }); assert.equal(f.activeObservers().length, 0); assert.equal(f.frames.size, 0);
    staleFrame(0); oldObserver.emit(); f.view.emit("resize"); f.flush(); assert.equal(f.value(), initial);
    f.geometry.height = 94; f.view.emit("pageshow", { persisted: true });
    staleFrame(0); f.controller.refresh();
    assert.equal(f.frames.size, 1, "a retired frame cannot clear the restored controller's newer pending frame");
    f.flush();
    assert.equal(f.activeObservers().length, 1); assert.equal(f.value(), height(94));
    f.geometry.height = 155; oldObserver.emit(); assert.equal(f.frames.size, 0, "the pre-pagehide observer is retired after restoration");
    f.activeObservers()[0].emit(); f.flush(); assert.equal(f.value(), height(155));
  } finally { f.controller.dispose(); }
});

function assertDisposed(install = installBottomLayout) {
  const f = fixture(install);
  f.flush(); const value = f.value(), writes = f.heightWrites().length;
  f.geometry.height = 140; f.controller.refresh(); const staleFrame = [...f.frames.values()][0]; assert(staleFrame);
  const observer = f.observers[0]; f.controller.dispose(); f.controller.dispose();
  assert.equal(f.frames.size, 0); assert.equal(f.activeObservers().length, 0); assert.equal(f.view.listenerCount(), 0);
  staleFrame(0); observer.emit(); f.controller.refresh(); f.view.emit("pageshow", { persisted: true }); f.view.emit("resize"); f.flush();
  assert.equal(f.value(), value, "disposed layout callbacks cannot publish a new height");
  assert.equal(f.heightWrites().length, writes, "late disposed callbacks cannot write root CSS");
  return f;
}

test("dispose removes listeners cancels queued work and rejects already delivered callbacks", () => { assertDisposed(); });

test("a disposed singleton can be reinstalled without its old controller deleting or mutating the new installation", () => {
  const f = assertDisposed();
  const current = f.installAgain();
  try {
    assert.notEqual(current, f.controller); f.geometry.height = 100; f.flush(); assert.equal(f.value(), height(100));
    f.controller.dispose(); assert.equal(f.installAgain(), current); assert.equal(f.activeObservers().length, 1);
  } finally { current.dispose(); }
});

async function mutant(before, after) {
  assert.equal(helperSource.split(before).length, 2, `one actual helper mutation boundary: ${before}`);
  const source = helperSource.replace(before, after);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)).installBottomLayout;
}

test("negative control: measuring scroll overflow includes the absolute navigation picker", async () => {
  const install = await mutant("nav.getBoundingClientRect().height", "nav.scrollHeight");
  assert.throws(() => assertBorderBox(install), /nav border box, including its safe-area padding, owns the published height/);
  console.log("Bottom layout metric negative control: correctly rejected picker overflow as navigation height.");
});

test("negative control: a disposed queued frame without lifecycle ownership can still publish", async () => {
  const install = await mutant("if (disposed || !running || scheduledEpoch !== epoch) return;", "if (false) return;");
  assert.throws(() => assertDisposed(install), /disposed layout callbacks cannot publish a new height/);
  console.log("Bottom layout lifecycle negative control: correctly rejected a disposed frame publishing root CSS.");
});
