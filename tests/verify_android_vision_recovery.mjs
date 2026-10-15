import assert from "node:assert/strict";
import fs from "node:fs";
import { createVisionHarness, deferred, settle } from "./fixtures/android-vision-recovery-harness.mjs";

// Full production createToolViews is evaluated unchanged apart from its ES export.
// Tests use only public renderTools and rendered button clicks; native storage,
// camera, navigation, and DOM boundaries are deterministic doubles, not devices.
const source = fs.readFileSync(new URL("../android-client/www/modules/tools/tool-views.js", import.meta.url), "utf8");
const historical = fs.readFileSync(new URL("./fixtures/android-vision-before-recovery.js", import.meta.url), "utf8");
assert(historical.includes("未完成的照片已经删除"), "Expected the fixed pre-recovery production snapshot");
const A = "20260830-120001-a1b2c3d4";
const B = "20260830-120002-b2c3d4e5";
const C = "20260830-120003-c3d4e5f6";
const complete = (patch = {}) => ({ sessionId: A, kind: "id-card", status: "complete", canReview: true, canResume: false, bytes: 2048, createdAt: 1788062400000, completedAt: 1788062405000, ...patch });
const capturing = (patch = {}) => ({ sessionId: B, kind: "id-card", status: "capturing", canReview: false, canResume: true, nextStep: "ID_BACK", bytes: 1024, createdAt: 1788062400000, ...patch });
const unavailable = (patch = {}) => ({ sessionId: C, kind: "bank-card", status: "unavailable", canReview: false, canResume: false, issue: "照片文件缺失，无法恢复此记录。", bytes: 512, createdAt: 1788062400000, ...patch });
const actions = [
  { name: "start", method: "startDocumentScan", button: (h) => h.button(/^证卡扫描/) },
  { name: "review", method: "openSession", button: (h) => h.button(/^复核$/, h.rows()[0]) },
  { name: "resume", method: "resumeSession", button: (h) => h.button(/^继续$/, h.rows()[1]) },
  { name: "delete", method: "deleteSession", button: (h) => h.button(/^删除$/, h.rows()[0]) }
];
const state = (h) => h.status()?.dataset.state;
const statusText = (h) => h.status()?.textContent || "";
const refresh = (h) => h.button(/^(?:刷新|重试)$/);
const openButtons = (row) => row.querySelectorAll("button").filter((button) => /^(?:复核|继续)$/.test(button.textContent));
const success = (method) => method === "deleteSession" ? { deleted: true } : { canceled: false, kind: "id-card", fileCount: 2 };
async function actionPage(h) { h.setSessions([complete(), capturing()]); await h.render(); }

const tests = [];
const test = (name, run, control = false) => tests.push({ name, run, control });

test("complete, capturing, and unavailable records expose only their allowed actions", async (h) => {
  h.setSessions([complete(), capturing(), unavailable()]);
  await h.render();
  const rows = h.rows();
  assert.equal(rows.length, 3);
  assert.deepEqual(openButtons(rows[0]).map((button) => button.textContent), ["复核"]);
  assert.deepEqual(openButtons(rows[1]).map((button) => button.textContent), ["继续"]);
  assert.deepEqual(openButtons(rows[2]).map((button) => button.textContent), []);
  assert.match(rows[1].textContent, /国徽面|ID_BACK/, "resume row must describe the next ID side");
  assert(rows[2].textContent.includes(unavailable().issue), "unavailable row omitted the native reason");
  for (const row of rows) assert(h.button(/^删除$/, row));
}, "historical");

test("legacy complete records without capability flags retain review", async (h) => {
  const legacy = complete(); delete legacy.canReview; delete legacy.canResume;
  h.setSessions([legacy]); await h.render();
  h.click(h.button(/^复核$/, h.rows()[0])); await settle();
  assert.equal(h.count("openSession"), 1);
  assert.deepEqual(h.calls.find((call) => call.method === "openSession").options, { sessionId: A });
});

for (const [name, record] of [
  ["unknown status", complete({ status: "future-state" })],
  ["capturing without affirmative resume capability", capturing({ canResume: undefined })],
  ["explicitly disabled capture", capturing({ canResume: false })],
  ["string resume flag", capturing({ canResume: "false" })],
  ["explicitly disabled review", complete({ canReview: false })],
  ["string review flag", complete({ canReview: "true" })],
  ["missing status", complete({ status: undefined })]
]) {
  test(`${name} never invents a review or resume action`, async (h) => {
    h.setSessions([record]); await h.render();
    assert.equal(h.rows().length, 1);
    assert.equal(openButtons(h.rows()[0]).length, 0);
    assert.match(h.rows()[0].textContent, /无法|不可|不完整|恢复/);
  }, "historical");
}

test("null and missing-ID records cannot invoke any native session action", async (h) => {
  h.setSessions([null, complete({ sessionId: "" }), capturing({ sessionId: null })]); await h.render();
  for (const row of h.rows()) {
    assert.equal(openButtons(row).length, 0);
    const remove = h.button(/^删除$/, row);
    if (remove) { assert.equal(remove.disabled, true); h.click(remove); }
  }
  assert.equal(h.count("openSession") + h.count("resumeSession") + h.count("deleteSession"), 0);
}, "historical");

for (const [label, sessionId, control] of [
  ["empty", "", "empty-id"],
  ["whitespace-only", "   ", "trim-id"],
  ["numeric", 123, "typed-id"],
  ["object", { value: A }, "typed-id"]
]) {
  test(`${label} IDs are unavailable even when native capability flags are true`, async (h) => {
    h.setSessions([complete({ sessionId }), capturing({ sessionId })]); await h.render();
    assert.equal(h.rows().length, 2);
    for (const row of h.rows()) {
      assert.equal(row.dataset.state, "unavailable", "bad ID was announced as a recoverable record");
      assert.equal(openButtons(row).length, 0);
      assert.equal(h.button(/^删除$/, row).disabled, true);
    }
  }, control);
}

for (const kind of ["future-kind", "", undefined]) {
  test(`unknown kind ${String(kind)} cannot offer review or continue`, async (h) => {
    h.setSessions([complete({ kind }), capturing({ kind })]); await h.render();
    for (const row of h.rows()) {
      assert.equal(row.dataset.state, "unavailable");
      assert.equal(openButtons(row).length, 0);
      assert(h.button(/^删除$/, row), "unknown data must remain explicitly deletable");
    }
  }, "known-kind");
}

test("all three known kinds remain actionable and trimmed IDs reach the bridge", async (h) => {
  h.setSessions([
    complete({ kind: "id-card" }),
    complete({ kind: "bank-card" }),
    complete({ kind: "face-verification" }),
    capturing({ sessionId: `  ${B}  `, kind: "face-verification", nextStep: "FACE" })
  ]);
  await h.render();
  for (const row of h.rows().slice(0, 3)) assert(h.button(/^复核$/, row));
  assert.match(h.rows()[3].textContent, /人脸/);
  h.click(h.button(/^继续$/, h.rows()[3])); await settle();
  assert.deepEqual(h.calls.find((call) => call.method === "resumeSession").options, { sessionId: B });
}, "trim-id");

test("continue uses resumeSession with the exact ID and refreshes after completion", async (h) => {
  await actionPage(h);
  h.enqueue("resumeSession", { canceled: false, kind: "id-card", fileCount: 2 });
  h.click(actions[2].button(h)); await settle();
  assert.equal(h.count("resumeSession"), 1);
  assert.equal(h.count("openSession"), 0);
  assert.deepEqual(h.calls.find((call) => call.method === "resumeSession").options, { sessionId: B });
  assert.equal(state(h), "success");
  assert.match(statusText(h), /2/);
  assert.equal(h.count("listSessions"), 2);
}, "historical");

for (const action of [actions[0], actions[2]]) {
  for (const [label, result, expected] of [
    ["preserved cancellation", { canceled: true, preserved: true, discarded: false }, /保留/],
    ["unclassified cancellation", { canceled: true }, /退出|取消|返回/],
    ["discarded cancellation", { canceled: true, preserved: false, discarded: true }, /已删除|已经删除/]
  ]) {
    test(`${action.name} ${label} reports only the confirmed disposition`, async (h) => {
      await actionPage(h); h.enqueue(action.method, result);
      h.click(action.button(h)); await settle();
      assert.match(statusText(h), expected);
      assert.notEqual(state(h), "success");
      if (result.discarded !== true) assert.doesNotMatch(statusText(h), /已删除|已经删除/, "canceled photos were falsely reported as deleted");
    }, label !== "discarded cancellation" || action.name === "resume" ? "historical" : false);
  }
}

test("an unclassified native return never claims completed capture", async (h) => {
  await actionPage(h); h.enqueue("startDocumentScan", {});
  h.click(actions[0].button(h)); await settle();
  assert.notEqual(state(h), "success");
  assert.doesNotMatch(statusText(h), /探索已完成/);
}, "historical");

test("missing delete API never claims successful deletion", async (h) => {
  await actionPage(h); delete h.plugin.deleteSession;
  h.click(actions[3].button(h)); await settle();
  assert.equal(h.count("deleteSession"), 0);
  assert.equal(state(h), "error");
  assert.doesNotMatch(statusText(h), /记录已删除|照片已删除/);
}, "historical");

for (const result of [{ deleted: false }, {}, { deleted: "true" }]) {
  test(`delete result ${JSON.stringify(result)} is not treated as confirmed deletion`, async (h) => {
    await actionPage(h); h.enqueue("deleteSession", result);
    h.click(actions[3].button(h)); await settle();
    assert.equal(h.count("deleteSession"), 1);
    assert.equal(state(h), "error");
    assert.equal(actions[3].button(h).disabled, false);
  }, "historical");
}

test("confirmed delete refreshes the list and passes the selected ID", async (h) => {
  await actionPage(h);
  h.enqueue("deleteSession", () => { h.setSessions([capturing()]); return { deleted: true }; });
  h.click(actions[3].button(h)); await settle();
  assert.deepEqual(h.calls.find((call) => call.method === "deleteSession").options, { sessionId: A });
  assert.equal(h.rows().length, 1);
  assert.match(statusText(h), /已删除/);
  assert.equal(state(h), "neutral");
});

test("canceling deletion confirmation performs no native operation", async (h) => {
  await actionPage(h); h.setConfirm(false);
  h.click(actions[3].button(h)); await settle();
  assert.equal(h.count("deleteSession"), 0);
  assert.equal(h.confirms.length, 1);
  assert.equal(actions[3].button(h).disabled, false);
});

for (const action of actions) {
  test(`${action.name} excludes double clicks and every other action until settled`, async (h) => {
    await actionPage(h);
    const pending = deferred(); h.enqueue(action.method, pending);
    const first = action.button(h); h.click(first); h.click(first);
    for (const other of actions) h.click(other.button(h));
    h.click(h.button(/^人脸与真人验证/));
    await settle();
    const actionCalls = h.calls.filter((call) => call.method !== "listSessions");
    assert.deepEqual(actionCalls.map((call) => call.method), [action.method]);
    assert.equal(h.maximumActiveActions, 1);
    pending.resolve(success(action.method)); await settle();
    for (const other of actions) assert.equal(other.button(h).disabled, false);
  }, "mutex");

  test(`${action.name} failure restores controls and permits an explicit retry`, async (h) => {
    await actionPage(h); h.enqueue(action.method, new Error(`SYNTHETIC ${action.name} FAILURE`));
    h.click(action.button(h)); await settle();
    assert.equal(state(h), "error");
    assert.match(statusText(h), /SYNTHETIC/);
    assert.equal(action.button(h).disabled, false);
    h.click(action.button(h)); await settle();
    assert.equal(h.count(action.method), 2);
    assert.equal(action.button(h).disabled, false);
  }, action.name === "resume" ? "historical" : false);
}

test("redrawing during an outstanding action does not allow another native launch", async (h) => {
  await actionPage(h); const pending = deferred(); h.enqueue("startDocumentScan", pending);
  h.click(actions[0].button(h)); await h.render();
  for (const action of actions) h.click(action.button(h));
  assert.equal(h.calls.filter((call) => call.method !== "listSessions").length, 1);
  pending.resolve({ canceled: true, preserved: true }); await settle();
  assert.equal(actions[0].button(h).disabled, false);
  h.click(actions[0].button(h)); await settle();
  assert.equal(h.count("startDocumentScan"), 2);
}, "mutex");

test("a redrawn busy section preserves aria-busy until the native action settles", async (h) => {
  await actionPage(h); const pending = deferred(); h.enqueue("startDocumentScan", pending);
  h.click(actions[0].button(h)); await h.render();
  const section = h.els.viewContent.querySelector(".vision-exploration-dashboard");
  const whilePending = section.getAttribute("aria-busy");
  pending.resolve({ canceled: true, preserved: true }); await settle();
  assert.equal(whilePending, "true", "new section lost the existing native busy state");
  assert.equal(section.getAttribute("aria-busy"), "false");
}, "aria-busy");

test("action failure plus archive-refresh failure still unlocks explicit retry", async (h) => {
  await actionPage(h);
  h.enqueue("startDocumentScan", new Error("ACTION FAILURE MARKER"));
  h.enqueue("listSessions", new Error("REFRESH FAILURE MARKER"));
  h.click(actions[0].button(h)); await settle();
  assert.match(statusText(h), /ACTION FAILURE MARKER/);
  assert.match(h.els.viewContent.textContent, /REFRESH FAILURE MARKER/);
  assert.equal(actions[0].button(h).disabled, false);
  assert.equal(refresh(h).disabled, false);
  h.click(actions[0].button(h)); await settle();
  assert.equal(h.count("startDocumentScan"), 2);
}, "finally-unlock");

for (const action of actions) {
  for (const outcome of ["success", "failure"]) {
    test(`old ${action.name} ${outcome} cannot alter a redrawn page or refresh its list`, async (h) => {
      await actionPage(h); const pending = deferred(); h.enqueue(action.method, pending);
      h.click(action.button(h)); await settle();
      await h.render();
      const before = h.els.viewContent.textContent;
      const reads = h.count("listSessions");
      if (outcome === "success") pending.resolve(success(action.method));
      else pending.reject(new Error("OLD VIEW ERROR MUST NOT APPEAR"));
      await settle();
      assert.equal(h.els.viewContent.textContent, before);
      assert.equal(h.count("listSessions"), reads, "old action started a fresh read on the new page");
      assert.equal(actions[0].button(h).disabled, false);
    }, action.name === "resume" ? "view-status" : "historical");
  }
}

test("an outstanding action cannot mutate an unrelated page after leaving", async (h) => {
  await actionPage(h); const pending = deferred(); h.enqueue("startDocumentScan", pending);
  h.click(actions[0].button(h)); await settle();
  h.leave(); const reads = h.count("listSessions");
  pending.resolve({ canceled: false, fileCount: 2 }); await settle();
  assert.equal(h.els.viewContent.textContent, "OTHER PAGE MUST STAY UNCHANGED");
  assert.equal(h.count("listSessions"), reads);
});

for (const outcome of ["success", "failure"]) {
  test(`an old list ${outcome} cannot replace a new page's records`, async (h) => {
    const old = deferred(); h.enqueue("listSessions", old);
    h.api.renderTools(); await settle();
    h.setSessions([unavailable({ issue: "NEW PAGE MARKER" })]); await h.render();
    const before = h.els.viewContent.textContent;
    if (outcome === "success") old.resolve({ sessions: [complete()] });
    else old.reject(new Error("OLD LIST ERROR"));
    await settle();
    assert.equal(h.els.viewContent.textContent, before);
  });

  test(`a stale same-page list ${outcome} cannot overwrite a newer refresh`, async (h) => {
    h.setSessions([complete()]); await h.render();
    const old = deferred(); const latest = deferred();
    h.enqueue("listSessions", old); h.enqueue("listSessions", latest);
    h.click(refresh(h)); h.click(refresh(h)); await settle();
    assert.equal(h.count("listSessions"), 3, "public refresh did not issue the requested overlapping reads");
    latest.resolve({ sessions: [unavailable({ issue: "LATEST LIST MARKER" })] }); await settle();
    const before = h.els.viewContent.textContent;
    if (outcome === "success") old.resolve({ sessions: [complete()] });
    else old.reject(new Error("STALE LIST ERROR"));
    await settle();
    assert.equal(h.els.viewContent.textContent, before);
    assert.match(before, /LATEST LIST MARKER/);
  }, "read-order");
}

test("list failures show a refresh retry that can subsequently load records", async (h) => {
  h.enqueue("listSessions", new Error("SYNTHETIC LIST ERROR")); await h.render();
  assert.match(h.els.viewContent.textContent, /SYNTHETIC LIST ERROR/);
  assert(refresh(h));
  h.setSessions([capturing()]); h.click(refresh(h)); await settle();
  assert.equal(h.rows().length, 1);
  assert(h.button(/^继续$/, h.rows()[0]));
}, "historical");

test("malformed list responses are errors rather than fabricated empty archives", async (h) => {
  h.enqueue("listSessions", { sessions: "not-an-array" }); await h.render();
  assert.match(h.els.viewContent.textContent, /无效|失败|重试/);
  assert(refresh(h));
}, "historical");

test("missing native support remains readable and actionable failures are explicit", async (h) => {
  delete h.window.Capacitor.Plugins.FanHaoVisionExploration;
  await h.render();
  assert.match(h.els.viewContent.textContent, /Android/);
  h.click(actions[0].button(h)); await settle();
  assert.equal(state(h), "error");
  assert.equal(h.calls.length, 0);
});

for (const [method, action] of [["resumeSession", actions[2]], ["openSession", actions[1]]]) {
  test(`missing ${method} reports an error without leaving controls disabled`, async (h) => {
    await actionPage(h); delete h.plugin[method];
    h.click(action.button(h)); await settle();
    assert.equal(state(h), "error");
    assert.equal(action.button(h).disabled, false);
    assert.equal(h.count(method), 0);
  }, method === "resumeSession" ? "historical" : false);
}

test("native issue text is rendered as text rather than an HTML sink", async (h) => {
  const payload = '<img src=x onerror="globalThis.compromised=true"><script>bad()</script>';
  h.setSessions([unavailable({ issue: payload, kind: payload })]); await h.render();
  assert(!h.document.htmlWrites.some((value) => value.includes(payload)), "untrusted issue reached innerHTML");
  assert(h.rows()[0].textContent.includes(payload));
}, "issue-html");

test("native error text is rendered as text rather than an HTML sink", async (h) => {
  const payload = '<img src=x onerror="globalThis.compromised=true">NATIVE ERROR';
  await actionPage(h); h.enqueue("startDocumentScan", new Error(payload));
  h.click(actions[0].button(h)); await settle();
  assert(!h.document.htmlWrites.some((value) => value.includes(payload)), "untrusted error reached innerHTML");
  assert(statusText(h).includes(payload));
}, "status-html");

test("invalid and out-of-range timestamps do not prevent later records from rendering", async (h) => {
  h.setSessions([complete({ completedAt: 1e100, bytes: "nonsense" }), capturing({ createdAt: "bad-date" }), unavailable({ createdAt: -1 })]);
  await h.render();
  assert.equal(h.rows().length, 3, "malformed timestamp crashed archive rendering");
  for (const row of h.rows()) assert.match(row.textContent, /时间未知/);
  assert(h.button(/^继续$/, h.rows()[1]));
}, "historical");

function controlSource(kind) {
  if (kind === "historical") return historical;
  if (kind === "empty-id") {
    assert(source.includes("Boolean(sessionId) && knownKind &&"), "Expected empty-ID capability guard");
    return source.replaceAll("Boolean(sessionId) && knownKind &&", "knownKind &&");
  }
  if (kind === "typed-id" || kind === "trim-id") {
    const normalizer = 'typeof session?.sessionId === "string" ? session.sessionId.trim() : ""';
    assert(source.includes(normalizer), "Expected strict trimmed session ID normalizer");
    return source.replace(normalizer, kind === "typed-id" ? 'String(session?.sessionId || "")' : 'typeof session?.sessionId === "string" ? session.sessionId : ""');
  }
  if (kind === "known-kind") {
    assert(source.includes(" && knownKind &&"), "Expected known-kind capability guard");
    return source.replaceAll(" && knownKind &&", " &&");
  }
  if (kind === "aria-busy") {
    const initialization = 'section.setAttribute("aria-busy", String(explorationBusy));';
    assert(source.includes(initialization), "Expected busy state on freshly created sections");
    return source.replace(initialization, "");
  }
  if (kind === "finally-unlock") {
    assert(source.includes("setExplorationBusy(false);"), "Expected action-finally unlock");
    return source.replace("setExplorationBusy(false);", "");
  }
  if (kind === "mutex") {
    for (const guard of ["if (explorationBusy ||", "button.disabled = explorationBusy", "else button.disabled = busy"]) {
      assert(source.includes(guard), `Expected exact action mutex guard: ${guard}`);
    }
    return source.replaceAll("if (explorationBusy ||", "if (false ||")
      .replaceAll("button.disabled = explorationBusy", "button.disabled = false")
      .replaceAll("else button.disabled = busy", "else button.disabled = false");
  }
  if (kind === "view-status") {
    const declaration = 'function updateExplorationStatus(view, message, state = "neutral") {';
    assert(source.includes(declaration), "Expected exact status ownership boundary");
    // Recreate the old global-target bug while keeping resume support available.
    return source.replace(declaration, declaration + "\n    view = explorationView;");
  }
  if (kind === "issue-html" || kind === "status-html") {
    const assignment = kind === "issue-html" ? "issue.textContent = canResume" : "view.status.textContent = message";
    assert(source.includes(assignment), `Expected exact safe text assignment: ${assignment}`);
    return source.replace(assignment, assignment.replace("textContent", "innerHTML"));
  }
  if (kind === "read-order") {
    assert(source.includes(" || readId !== view.readId") && source.includes(" && readId === view.readId"), "Expected exact list generation guards for a bounded negative control");
    return source.replaceAll(" || readId !== view.readId", "").replaceAll(" && readId === view.readId", "");
  }
  throw new Error(`Unknown negative control: ${kind}`);
}

let passed = 0;
let controls = 0;
const failures = [];
for (const item of tests) {
  if (!process.argv.includes("--negative-only")) {
    try { await item.run(createVisionHarness(source)); passed += 1; console.log(`PASS ${item.name}`); }
    catch (error) { failures.push(item.name); console.error(`FAIL ${item.name}\n${error.stack}`); }
  }
  if (item.control) {
    const candidate = controlSource(item.control);
    try {
      await item.run(createVisionHarness(candidate));
      failures.push(`${item.name} (negative control unexpectedly passed)`);
      console.error(`FAIL negative control unexpectedly passed: ${item.name}`);
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) {
        failures.push(`${item.name} (negative control failed for wrong reason)`);
        console.error(`FAIL negative control failed for wrong reason: ${item.name}\n${error.stack}`);
      } else {
        controls += 1;
        console.log(`CONTROL ${item.control}: ${item.name} (${error.message.split("\n")[0]})`);
      }
    }
  }
}
console.log(`Android vision recovery verification: ${passed} current-source scenarios passed; ${controls} regression controls reproduced; ${failures.length} failures.`);
if (failures.length) process.exitCode = 1;
