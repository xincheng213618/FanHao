import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createComputerControlRuntime } from "../src/modules/system/server/computer-control/runtime.js";
import { commandForAction, createComputerControlService } from "../src/modules/system/server/computer-control/service.js";
import { createStaticFileServer } from "../src/platform/server/static-files.js";
import { createAuthServices } from "../src/platform/server/auth.js";
import { routeAdminApi } from "../src/modules/system/server/admin/routes.js";

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
console.log(`System control verification passed: ${cases.length * 3} actual network/admin gate cases plus command dispatch checks (commands mocked; no real OS action executed).`);
