import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import os from "node:os";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createComputerControlRuntime } from "../src/modules/system/server/computer-control/runtime.js";
import { commandForAction, createComputerControlService, launchComputerControlCommand } from "../src/modules/system/server/computer-control/service.js";
import { createStaticFileServer } from "../src/platform/server/static-files.js";
import { createAuthServices } from "../src/platform/server/auth.js";
import { routeAdminApi } from "../src/modules/system/server/admin/routes.js";
import { createAdminScriptService } from "../src/modules/system/server/admin-script-service.js";
import { createAdminTaskService } from "../src/modules/system/server/admin-task-service.js";
import { createAdminTaskOrchestrationService } from "../src/modules/system/server/admin-task-orchestration-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launched = [];
const scheduled = [];
const service = createComputerControlService({
  platform: "win32",
  launch(file, args) {
    launched.push({ file, args });
    return { once() {} };
  },
  schedule(callback, delayMs) {
    scheduled.push({ callback, delayMs });
    return { unref() {} };
  },
  now: () => new Date("2026-09-19T01:02:03.000Z")
});

assert.deepEqual(commandForAction("shutdown", "win32"), {
  file: "shutdown.exe",
  args: ["/s", "/t", "60"]
});
assert.equal(commandForAction("cancel", "darwin"), null, "macOS must not advertise an unsupported cancel action");
assert.deepEqual(service.status().actions.map((action) => action.id), ["lock", "mute", "sleep", "restart", "shutdown", "cancel"]);

const result = service.dispatch("shutdown");
assert.equal(result.ok, true);
assert.equal(result.queuedAt, "2026-09-19T01:02:03.000Z");
assert.equal(launched.length, 0, "control commands must be deferred until after the HTTP response can be written");
assert.equal(scheduled[0].delayMs, 250);
scheduled[0].callback();
assert.deepEqual(launched, [{ file: "shutdown.exe", args: ["/s", "/t", "60"] }]);

const sleepCommand = commandForAction("sleep", "win32");
assert.deepEqual(sleepCommand, { file: "shutdown.exe", args: ["/h"] },
  "sleep must request hibernation through the built-in command, without force-close, timeout, shutdown or logoff flags");

service.dispatch("sleep");
assert.equal(launched.length, 1, "sleep must also wait until after the HTTP response");
scheduled[1].callback();
assert.deepEqual(launched[1], sleepCommand);
assert.equal(service.status().lastDispatch.action, "sleep");

for (const outcome of ["success", "exit-error", "signal", "spawn-error", "throw"]) {
  const child = new EventEmitter();
  const warnings = [];
  let run, launches = 0;
  const fixtureService = createComputerControlService({
    platform: "win32",
    schedule(callback) { run = callback; },
    launch() {
      launches++;
      if (outcome === "throw") throw Error("synthetic launch failure");
      return child;
    },
    warn(...args) { warnings.push(args); }
  });
  fixtureService.dispatch("sleep");
  const queuedSnapshot = fixtureService.status().lastDispatch;
  assert.equal(queuedSnapshot.status, "queued");
  run();
  if (outcome === "success") child.emit("exit", 0, null);
  if (outcome === "exit-error") child.emit("exit", 5, null);
  if (outcome === "signal") child.emit("exit", null, "SIGTERM");
  if (outcome === "spawn-error") {
    child.emit("error", Error("synthetic permission error"));
    child.emit("exit", 0, null);
  }
  const finalState = fixtureService.status().lastDispatch;
  assert.equal(finalState.status, outcome === "success" ? "completed" : "failed", outcome);
  assert.equal(queuedSnapshot.status, "queued", "status must return a snapshot, not mutable dispatch state");
  assert.equal(warnings.length, outcome === "success" ? 0 : 1, outcome);
  if (outcome !== "success") assert(finalState.error, "failed commands must remain inspectable");
  if (outcome === "exit-error") assert.equal(finalState.exitCode, 5);
  assert.equal(launches, 1, "failure must not retry or fall back to a different power action");
}

{
  const children = [];
  let run;
  const fixtureService = createComputerControlService({ platform: "win32", warn() {},
    schedule(callback) { run = callback; },
    launch() { const child = new EventEmitter(); children.push(child); return child; }
  });
  fixtureService.dispatch("sleep"); run();
  fixtureService.dispatch("lock"); run();
  children[0].emit("exit", 5, null);
  assert.equal(fixtureService.status().lastDispatch.action, "lock");
  assert.equal(fixtureService.status().lastDispatch.status, "dispatched", "a late failure must not replace the latest action");
}

// Exercise the production launcher with harmless real console processes.
// A detached PowerShell can exit zero without executing even a file write.
const launchFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-control-launch-"));
const markerPath = path.join(launchFixtureDir, "executed.txt");
try {
  const probe = process.platform === "win32"
    ? { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command",
      `Set-Content -LiteralPath '${markerPath.replaceAll("'", "''")}' -Value 'control-launch-executed'`] }
    : { file: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'control-launch-executed')`] };
  await waitForCommand(probe.file, probe.args);
  assert.equal(fs.readFileSync(markerPath, "utf8").trim(), "control-launch-executed", "successful exit must actually execute the command body");
  // shutdown's help-only mode can return 1 even though it starts successfully.
  if (process.platform === "win32") await waitForCommand(sleepCommand.file, ["/?"], [0, 1]);
} finally {
  if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
  fs.rmdirSync(launchFixtureDir);
}

async function waitForCommand(file, args, acceptedCodes = [0]) {
  await new Promise((resolve, reject) => {
    const child = launchComputerControlCommand(file, args);
    const timeout = setTimeout(() => { child.kill(); reject(Error("control launch fixture timed out")); }, 15000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (acceptedCodes.includes(code)) resolve();
      else reject(Error(`${file} control launch fixture failed: ${code ?? signal}`));
    });
  });
}

assert.throws(() => service.dispatch("format-disk"), (error) => error.statusCode === 400);

let response = null;
let bodyReads = 0;
let allowed = false;
const runtime = createComputerControlRuntime({
  service,
  readJsonBody: async () => { bodyReads += 1; return { action: "lock" }; },
  requireLocalAdmin(_req, _res) {
    if (allowed) return true;
    response = { status: 403, payload: { error: "forbidden" } };
    return false;
  },
  sendJson(_res, status, payload) { response = { status, payload }; }
});

assert.equal(await runtime.routeApi({ method: "POST" }, {}, new URL("http://fixture/api/system/control")), true);
assert.equal(bodyReads, 0, "denied control requests must be rejected before reading the body");
assert.deepEqual(response, { status: 403, payload: { error: "forbidden" } });

allowed = true;
response = null;
assert.equal(await runtime.routeApi({ method: "GET" }, {}, new URL("http://fixture/api/system/control")), true);
assert.equal(response.status, 200);
assert.equal(response.payload.platform, "win32");

response = null;
assert.equal(await runtime.routeApi({ method: "POST" }, {}, new URL("http://fixture/api/system/control")), true);
assert.equal(bodyReads, 1);
assert.equal(response.status, 202);
assert.equal(response.payload.action, "lock");

const settingsActions = runtime.settings.schema.sections[0].actions;
assert.equal(settingsActions.length, 6);
assert.match(settingsActions.find((action) => action.id === "shutdown").confirm, /60 秒后关闭/);
const settingsResult = runtime.settings.action("cancel");
assert.equal(settingsResult.action, "cancel");

const publicDir = path.join(root, "public");
const staticServer = createStaticFileServer({
  publicDir,
  mimeTypes: { ".html": "text/html" },
  normalizeExt: (value) => path.extname(value).toLowerCase(),
  notFound() {}
});
assert.equal(
  staticServer.publicFilePath("/system-control"),
  path.join(publicDir, "modules", "system", "computer-control", "index.html")
);

const pageSource = fs.readFileSync(path.join(publicDir, "modules", "system", "computer-control", "app.js"), "utf8");
assert(pageSource.includes('method: "POST"'), "the control page must use POST for actions");
assert(pageSource.includes("window.confirm(action.confirm)"), "dangerous actions must require an explicit confirmation");
assert(!pageSource.includes('href="/shutdown"'), "the control page must not restore GET-based mutations");

// Exercise the production admin gate and auth network classification, including
// the settings action route that can dispatch the same OS operation.
const serverSource = fs.readFileSync(path.join(root, "server.js"), "utf8");
const authFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-control-auth-"));
const authSecretPath = path.join(authFixtureDir, "synthetic-secret.json");
process.once("exit", () => {
  if (fs.existsSync(authSecretPath)) fs.unlinkSync(authSecretPath);
  fs.rmdirSync(authFixtureDir);
});
const auth = createAuthServices({ remoteWebPassword: "", authSecretPath, ensureDataDir() {} });
let securedResponse, securedReads = 0, securedDispatches = 0;
const sendJson = (_res, status, payload) => { securedResponse = { status, payload }; };
const gateContext = vm.createContext({ sendJson,
  requestAuthState: (req, url) => ({ ...auth.requestAuthState(req, url), ...(req.fixtureUser ? { user: req.fixtureUser } : {}) }),
  requestAccess: auth.requestAccess, isTrustedNetworkAccess: auth.isTrustedNetworkAccess, isSameTrustedNetworkOrigin: auth.isSameTrustedNetworkOrigin, URL });
for (const name of ["requireTrustedNetworkPage", "requireLocalAdmin"]) {
  const method = serverSource.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert(method, `Missing production ${name}`); vm.runInContext(method[0], gateContext);
}
const securedDeps = {
  requireLocalAdmin: gateContext.requireLocalAdmin, sendJson,
  readJsonBody: async () => { securedReads++; return { action: "sleep" }; }
};
const securedRuntime = createComputerControlRuntime({ ...securedDeps, service: {
  actionDescriptors: () => [], status: () => ({ ok: true, actions: [{ id: "sleep" }] }),
  dispatch: () => { securedDispatches++; return { ok: true }; }
} });
const androidHeaders = { origin: "http://localhost", "x-fanhao-client": "android" };
const cases = [
  { name: "direct LAN Android", peer: "192.168.1.50", host: "192.168.1.20:29998", allowed: true },
  { name: "loopback", peer: "::ffff:127.0.0.1", host: "localhost:29998", allowed: true },
  { name: "LAN IPv6", peer: "fd00::2", host: "[fd00::1]:29998", allowed: true },
  { name: "public peer", peer: "203.0.113.5", host: "public.example", allowed: false },
  { name: "public peer spoofing LAN Host", peer: "203.0.113.5", host: "192.168.1.20:29998", allowed: false },
  { name: "public Host through NAT loopback", peer: "192.168.1.1", host: "public.example", allowed: false },
  { name: "public Host through local proxy", peer: "127.0.0.1", host: "public.example", allowed: false },
  { name: "forwarded header cannot grant LAN", peer: "203.0.113.5", host: "192.168.1.20:29998", extra: { "x-forwarded-for": "192.168.1.50" }, allowed: false },
  { name: "public admin account", peer: "203.0.113.5", host: "public.example", user: { role: "admin" }, allowed: false },
  { name: "LAN ordinary account", peer: "192.168.1.50", host: "192.168.1.20:29998", user: { role: "user" }, allowed: false },
  { name: "cross-origin LAN page", peer: "192.168.1.50", host: "192.168.1.20:29998", extra: { origin: "https://foreign.example" }, allowed: false }
];
for (const testCase of cases) for (const entry of ["status", "control", "settings-action"]) {
  securedResponse = null; securedReads = 0; securedDispatches = 0;
  const req = { method: entry === "status" ? "GET" : "POST", socket: { remoteAddress: testCase.peer },
    headers: { host: testCase.host, ...androidHeaders, ...testCase.extra }, fixtureUser: testCase.user };
  if (entry === "settings-action") {
    await routeAdminApi(req, {}, new URL("http://fixture/api/admin/settings/system/actions/sleep"), { ...securedDeps,
      adminSettingsService: { async runModuleSettingsActionResponse() { securedDispatches++; return { statusCode: 202, payload: { ok: true } }; } } });
  } else await securedRuntime.routeApi(req, {}, new URL("http://fixture/api/system/control"));
  assert.equal(securedResponse.status, testCase.allowed ? entry === "status" ? 200 : 202 : 403, `${testCase.name}: ${entry}`);
  const expectedWrites = testCase.allowed && entry !== "status" ? 1 : 0;
  assert.equal(securedReads, expectedWrites, `${testCase.name}: reject before reading a command`);
  assert.equal(securedDispatches, expectedWrites, `${testCase.name}: reject before queuing any OS action`);
}
console.log(`System control verification passed: ${cases.length * 3} actual network/admin gate cases, dispatch/failure status and safe real console launch (power actions mocked; no real OS action executed).`);

const taskFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-admin-tasks-"));
const taskPaths = {
  history: path.join(taskFixtureDir, "tasks.json"),
  hold: path.join(taskFixtureDir, "hold.mjs"),
  quick: path.join(taskFixtureDir, "quick.mjs")
};
const tasksOptions = { cwd: taskFixtureDir, ensureDataDir() {}, historyLimit: 1, tasksPath: taskPaths.history };
const taskService = createAdminTaskService({ ...tasksOptions, onTaskDone(task) {
  if (task.scriptId === "fixture-refresh-failure") throw Error("synthetic index refresh failure");
} });
const taskChildren = new Map();

function waitForTask(task) {
  if (!task.child) return Promise.resolve();
  const child = task.child;
  if (!taskChildren.has(child)) taskChildren.set(child, new Promise(resolve => child.once("close", resolve)));
  return taskChildren.get(child);
}

const adminScriptService = createAdminScriptService({ definitions: [
  { id: "image-library-rescan", title: "fixture gallery scan", runtime: "node", script: taskPaths.hold },
  { id: "core-local-scan", title: "fixture local scan", runtime: "node", script: taskPaths.hold },
  { id: "fixture-quick", title: "fixture quick", runtime: "node", script: taskPaths.quick },
  { id: "fixture-refresh-failure", title: "fixture refresh failure", runtime: "node", script: taskPaths.quick }
] });
const adminTaskOrchestrationService = createAdminTaskOrchestrationService({ adminScriptService, adminTaskService: taskService });

async function taskApi(method, pathname, body) {
  let response;
  await routeAdminApi({ method }, {}, new URL(pathname, "http://fixture"), {
    adminTaskOrchestrationService, requireLocalAdmin: () => true, readJsonBody: async () => body,
    sendJson: (_res, status, payload) => { response = { status, payload }; }
  });
  return response;
}

async function startTask(scriptId) {
  const response = await taskApi("POST", "/api/admin/scripts/run", { scriptId });
  assert.equal(response.status, 202);
  const task = taskService.list().find(item => item.id === response.payload.task.id);
  waitForTask(task);
  return task;
}

try {
  fs.writeFileSync(taskPaths.hold, "setTimeout(() => {}, 12000);\n");
  fs.writeFileSync(taskPaths.quick, "console.log('fixture complete');\n");
  const gallery = await startTask("image-library-rescan");
  const local = await startTask("core-local-scan");
  const quick = await startTask("fixture-quick");
  await waitForTask(quick);

  const listed = await taskApi("GET", "/api/admin/tasks");
  assert.deepEqual(listed.payload.summary, { total: 3, running: 2, stopping: 0, done: 1, error: 0, stopped: 0 });
  assert.equal(listed.payload.tasks.find(task => task.id === gallery.id)?.canStop, true);
  const persisted = JSON.parse(fs.readFileSync(taskPaths.history, "utf8")).tasks;
  assert.deepEqual(persisted.map(task => task.id), [quick.id, local.id, gallery.id]);
  assert.equal(createAdminTaskService({ ...tasksOptions, historyLimit: 3 }).list().filter(task => task.status === "stopped").length, 2);
  for (const scriptId of ["image-library-rescan", "core-local-scan"]) {
    assert.equal((await taskApi("POST", "/api/admin/scripts/run", { scriptId })).status, 409);
  }
  const requestStop = (task) => taskApi("POST", "/api/admin/tasks/stop", { taskId: task.id });
  assert.equal((await requestStop(gallery)).payload.task.status, "stopping");
  assert.equal((await requestStop(gallery)).payload.task.status, "stopping");
  await waitForTask(gallery);
  assert.equal(gallery.status, "stopped");
  assert.equal(gallery.logs.filter(line => line === "收到停止请求").length, 1);
  assert(taskService.list().includes(gallery), "a long-running task must retain its final receipt");
  assert(!taskService.list().includes(quick), "the finished history is still bounded");
  assert.equal((await requestStop(local)).status, 200);
  await waitForTask(local);
  assert.equal(local.status, "stopped");

  const refreshFailure = await startTask("fixture-refresh-failure");
  await waitForTask(refreshFailure);
  assert.equal(refreshFailure.exitCode, 0);
  assert.equal(refreshFailure.status, "error");
  assert.match(refreshFailure.logs.join("\n"), /任务完成后刷新失败.*synthetic index refresh failure/);
  assert.equal(createAdminTaskService(tasksOptions).list()[0].status, "error");

  let cleanupCalls = 0;
  const outputFailure = taskService.startProcessTask({ type: "fixture", label: "fixture callbacks", command: process.execPath,
    args: [taskPaths.quick], onStdout() { throw Error("synthetic output failure"); },
    onDone() { cleanupCalls++; throw Error("synthetic cleanup failure"); } });
  await waitForTask(outputFailure);
  assert.equal(outputFailure.status, "error");
  assert.equal(cleanupCalls, 1);
  assert.match(outputFailure.logs.join("\n"), /任务输出处理失败.*synthetic output failure/);
  assert.match(outputFailure.logs.join("\n"), /任务收尾失败.*synthetic cleanup failure/);

  const spawnFailure = taskService.startProcessTask({ type: "fixture", label: "fixture spawn failure",
    command: path.join(taskFixtureDir, "missing-command"), args: [], onDone() { cleanupCalls++; } });
  await waitForTask(spawnFailure);
  assert.equal(spawnFailure.status, "error");
  assert.equal(cleanupCalls, 2);
  assert.match(spawnFailure.logs.join("\n"), /ENOENT/);

  const nextQuick = await startTask("fixture-quick");
  await waitForTask(nextQuick);
  assert.equal(nextQuick.status, "done");
  console.log("Admin task verification passed: retained live tasks, exclusive scans, stopped receipt, failure persistence and subsequent script run.");
} finally {
  for (const child of taskChildren.keys()) {
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all(taskChildren.values());
  for (const file of [...Object.values(taskPaths), `${taskPaths.history}.tmp`]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(taskFixtureDir);
}
