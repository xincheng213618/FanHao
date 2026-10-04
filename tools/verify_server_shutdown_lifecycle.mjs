import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticFileServer } from "../src/platform/server/static-files.js";
import { createServerHost } from "../src/platform/server/server-host.js";
import { createRequestHandler } from "../src/platform/server/http-app.js";

// Evaluate the actual composition callbacks with controlled resources. The
// real HTTP case uses a synthetic FileHandle and an ephemeral port; no files,
// databases, media or production services are created, modified or opened.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainSource = fs.readFileSync(path.join(root, "server.js"), "utf8").replaceAll("\r\n", "\n");
const shortSource = fs.readFileSync(path.join(root, "src/apps/short-video-server.js"), "utf8").replaceAll("\r\n", "\n");
const mainStart = mainSource.indexOf("const serverHost = createServerHost({");
const mainEnd = mainSource.indexOf("\nserverHost.listen();", mainStart);
assert(mainStart >= 0 && mainEnd > mainStart);
let mainComposition = mainSource.slice(mainStart, mainEnd);
let shortComposition = shortSource.replace(/^import .+;\n/gm, "").replace("export async function startShortVideoServer", "return async function startShortVideoServer");
if (process.argv.includes("--legacy-cleanup")) {
  const guard = "try { await closeResource(); } catch (error) { failures.push(error); }";
  assert.equal(mainComposition.split(guard).length, 2);
  mainComposition = mainComposition.replace(guard, "await closeResource();");
}
if (process.argv.includes("--without-static-lifecycle")) {
  assert.equal(mainComposition.split("staticFiles.beginStop();").length, 2);
  assert.equal(mainComposition.split("() => staticFiles.stop()").length, 2);
  mainComposition = mainComposition.replace("staticFiles.beginStop();", "").replace("() => staticFiles.stop()", "() => undefined");
}
if (process.argv.includes("--legacy-startup-cleanup")) {
  const start = shortComposition.lastIndexOf("  } catch (error) {");
  assert(start > 0);
  shortComposition = shortComposition.slice(0, start) + "  } catch (error) { await registry.stop(); auth.closeAccounts(); throw error; }\n}";
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check) {
  const end = Date.now() + 2000;
  while (!check()) { assert(Date.now() < end, "fixture did not reach its controlled stage"); await new Promise(resolve => setTimeout(resolve, 1)); }
}
const error = name => Object.assign(new Error(name), { code: name });
const flatten = failure => failure instanceof AggregateError ? failure.errors.flatMap(flatten) : [failure];
const parallelResources = ["videoProbeService", "mediaResponseService", "mediaStreamService", "archiveImageService", "imageReaderCacheService", "workCoverMutationService", "mediaBlobStore", "fileServer", "staticFiles"];
const orderedResources = ["accessAnalyticsService", "workMoveJobService", "actorProfilePublicationLifecycleService", "actorProfileOutboxService", "moduleRegistry", "accountUserStateService", "closeAccounts"];

function mainFixture({ failures = {}, gates = {}, staticFiles = null, handler = () => {}, hostFactory = options => options } = {}) {
  const events = [];
  const dependencies = { requestHandler: handler, PORT: 0, HOST: "127.0.0.1", library: { availableRoots: [], missingRoots: [] }, createServerHost: hostFactory };
  for (const name of [...parallelResources, ...orderedResources]) {
    const close = () => {
      events.push(name);
      if (failures[name]) throw failures[name];
      return gates[name]?.promise;
    };
    dependencies[name] = name === "closeAccounts" ? close : { stop: close, close, beginStop() { events.push(`begin:${name}`); } };
  }
  if (staticFiles) dependencies.staticFiles = staticFiles;
  const options = new Function(...Object.keys(dependencies), `${mainComposition}\nreturn serverHost;`)(...Object.values(dependencies));
  return { options, events };
}

async function shortFixture({ discoveryError, constructionError, startError, stopErrors = {}, gates = {} } = {}) {
  const events = [], failure = error("START_FAILURE");
  let options, listenCount = 0;
  const stop = name => () => {
    events.push(`stop:${name}`);
    if (stopErrors[name]) throw stopErrors[name];
    return gates[name]?.promise;
  };
  const registry = { async start() { events.push("start:registry"); if (startError === "registry") throw failure; }, stop: stop("registry"), beginStop() { events.push("begin:registry"); }, routeApi() {}, routeMedia() {} };
  const statics = { async start() { events.push("start:static"); if (startError === "static") throw failure; }, stop: stop("static"), beginStop() { events.push("begin:static"); }, serveStatic() {} };
  const auth = { closeAccounts: stop("accounts") };
  const dependencies = {
    fs, path, SERVER_CONFIG: {}, createAuthServices: () => auth,
    async discoverFanHaoModules() { events.push("discover"); if (discoveryError) throw failure; return registry; },
    createStaticFileServer() { if (constructionError) throw failure; return statics; },
    createRequestHandler: value => value,
    createServerHost(value) { options = value; return { listen() { listenCount++; } }; },
    readBodyText() {}, sendJson() {}, sendText() {}, sendHtml() {}, redirect() {}, notFound() {}
  };
  const start = new Function(...Object.keys(dependencies), shortComposition)(...Object.values(dependencies));
  const pending = start({ DATA_DIR: root, SHORT_VIDEO_ROOTS: [] });
  pending.catch(() => {});
  return { pending, events, failure, options: () => options, listenCount: () => listenCount };
}

const cases = [];
const add = (name, run) => cases.push({ name, run });
add("main:every-cleanup-failure-still-closes-later-resources", async () => {
  for (const name of orderedResources) {
    const failure = error(name), f = mainFixture({ failures: { [name]: failure } });
    let actual;
    try { await f.options.stop(); } catch (caught) { actual = caught; }
    assert.deepEqual(f.events, [...parallelResources, ...orderedResources], `failed ${name} must not skip later cleanups`);
    assert.equal(actual, failure, "single cleanup failure preserves original identity");
  }
});
add("main:sync-and-async-parallel-failures-preserve-all-other-cleanups", async () => {
  const failures = parallelResources.map(error);
  const gates = { fileServer: deferred() };
  const f = mainFixture({ failures: Object.fromEntries(parallelResources.filter(name => name !== "fileServer").map(name => [name, failures[parallelResources.indexOf(name)]])), gates });
  let settled = false, actual;
  const pending = f.options.stop().catch(caught => { actual = caught; }).finally(() => { settled = true; });
  await until(() => f.events.length === parallelResources.length);
  assert.equal(settled, false); assert(!f.events.includes("closeAccounts"));
  gates.fileServer.reject(failures[7]); await pending;
  assert.deepEqual(flatten(actual), failures);
  assert.deepEqual(f.events, [...parallelResources, ...orderedResources]);
});
add("main:ordered-close-gate-and-mixed-errors-do-not-close-accounts-early", async () => {
  const gate = deferred(), early = error("FILE_FAILURE"), later = error("MODULE_FAILURE");
  const f = mainFixture({ failures: { fileServer: early, moduleRegistry: later }, gates: { workMoveJobService: gate } });
  let actual;
  const pending = f.options.stop().catch(caught => { actual = caught; });
  await until(() => f.events.includes("workMoveJobService"));
  assert(!f.events.includes("moduleRegistry")); assert(!f.events.includes("closeAccounts"));
  gate.resolve(); await pending; assert.deepEqual(flatten(actual), [early, later]);
  assert.deepEqual(f.events, [...parallelResources, ...orderedResources]);
});
add("main:success-and-stop-admission-retain-order", async () => {
  const f = mainFixture(); await f.options.beginStop(); await f.options.stop();
  assert.deepEqual(f.events.slice(0, 9), ["staticFiles", "fileServer", "videoProbeService", "mediaResponseService", "mediaStreamService", "archiveImageService", "imageReaderCacheService", "mediaBlobStore", "workCoverMutationService"].map(name => `begin:${name}`));
  assert(f.events.includes("begin:moduleRegistry"));
  assert.deepEqual(f.events.slice(10), [...parallelResources, ...orderedResources]);
});
add("main:actual-http-head-held-static-close-refuses-clean-exit", async () => {
  const gate = deferred(), exits = [], logs = [], operations = [];
  let closeEntered = false, statCalls = 0;
  const statics = createStaticFileServer({ publicDir: root, mimeTypes: {}, normalizeExt: () => ".bin", stopTimeoutMs: 25,
    notFound(res) { res.writeHead(404); res.end(); },
    async openFile() { return { async stat() { statCalls++; return { size: 1, isFile: () => true }; }, close() { closeEntered = true; return gate.promise; } }; }
  });
  const handler = createRequestHandler({
    attachAccessAnalytics() {}, attachAccessLogger() {}, requestCorsOrigin: () => "", requestAuthState: () => ({ allowed: true }),
    routeAuth: async () => false, routeApi: async () => false, routeMedia: async () => false, renderAndroidUpdatePage: () => "",
    serveStatic(req, res, route) { const task = statics.serveStatic(req, res, route); operations.push(task); return task; },
    sendHtml() {}, sendText() {}, sendJson() {}, logError(...args) { logs.push(args); }
  });
  const processRef = Object.assign(new EventEmitter(), { exit: code => exits.push(code) });
  const f = mainFixture({ staticFiles: statics, handler, hostFactory: options => createServerHost({ ...options, processRef,
    logger: { log() {}, error(...args) { logs.push(args); } }, networkInterfaces: () => ({}) }) });
  try {
    const server = f.options.listen(); if (!server.listening) await once(server, "listening");
    await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "HEAD", path: "/fixture.bin", agent: false }, res => {
        assert.equal(res.statusCode, 200); res.resume(); res.once("end", resolve); res.once("error", reject);
      }); req.once("error", reject); req.end();
    });
    await until(() => closeEntered); assert.equal(statCalls, 1);
    assert.equal(statics.diagnostics().active, 1);
    await f.options.shutdown("fixture");
    assert.deepEqual(exits, [1], "HTTP completion does not prove static FileHandle closure");
    assert(logs.some(args => flatten(args[1]).some(value => value?.code === "STATIC_FILE_STOP_INCOMPLETE")));
    assert.equal(statics.diagnostics().active, 1);
    gate.resolve(); await Promise.all(operations); assert.equal(statics.diagnostics().active, 0); assert.equal(await statics.start(), true);
  } finally {
    gate.resolve(); await Promise.allSettled(operations); await statics.stop();
    f.options.server.closeAllConnections(); await new Promise(resolve => f.options.server.close(resolve));
  }
});
add("short:normal-start-and-begin-stop-close-both-admissions", async () => {
  const f = await shortFixture(); await f.pending; assert.equal(f.listenCount(), 1);
  assert.deepEqual(f.events, ["discover", "start:static", "start:registry"]);
  await f.options().beginStop(); await f.options().stop();
  assert.deepEqual(f.events.slice(3), ["begin:static", "begin:registry", "stop:static", "stop:registry", "stop:accounts"]);
});
add("short:both-resource-stops-settle-before-accounts-close", async () => {
  const gate = deferred(), failure = error("STATIC_CLOSE_FAILURE"), f = await shortFixture({ gates: { registry: gate }, stopErrors: { static: failure } });
  await f.pending; let actual, settled = false;
  const pending = f.options().stop().catch(caught => { actual = caught; }).finally(() => { settled = true; });
  await until(() => f.events.includes("stop:registry")); assert.equal(settled, false); assert(!f.events.includes("stop:accounts"));
  gate.resolve(); await pending; assert.equal(actual, failure); assert.equal(f.events.at(-1), "stop:accounts");
});
add("short:multiple-stop-errors-include-account-close-failure", async () => {
  const failures = ["static", "registry", "accounts"].map(error), f = await shortFixture({ stopErrors: Object.fromEntries(["static", "registry", "accounts"].map((name, i) => [name, failures[i]])) });
  await f.pending; let actual; try { await f.options().stop(); } catch (caught) { actual = caught; }
  assert.deepEqual(flatten(actual), failures); assert.equal(f.events.at(-1), "stop:accounts");
});
add("short:discovery-and-static-construction-failures-close-acquired-resources", async () => {
  for (const phase of ["discoveryError", "constructionError", "static", "registry"]) {
    const f = await shortFixture({ [phase]: true, startError: phase });
    await assert.rejects(f.pending, caught => caught === f.failure);
    assert.equal(f.listenCount(), 0); assert.equal(f.events.at(-1), "stop:accounts", `startup phase ${phase}`);
    if (phase !== "discoveryError") assert(f.events.includes("stop:registry"));
    if (!["discoveryError", "constructionError"].includes(phase)) assert(f.events.includes("stop:static"));
  }
});
add("short:startup-and-cleanup-errors-keep-original-cause-and-close-accounts", async () => {
  const cleanup = error("MODULE_CLEANUP_FAILURE"), account = error("ACCOUNTS_CLEANUP_FAILURE");
  const f = await shortFixture({ startError: "registry", stopErrors: { registry: cleanup, accounts: account } });
  let actual; try { await f.pending; } catch (caught) { actual = caught; }
  assert.equal(actual.cause, f.failure); assert.deepEqual(flatten(actual), [f.failure, cleanup, account]);
  assert.equal(f.events.at(-1), "stop:accounts"); assert.equal(f.listenCount(), 0);
});

const selectedName = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
const selected = cases.filter(test => !selectedName || test.name === selectedName);
assert(selected.length, `unknown case ${selectedName}`);
for (const test of selected) { await test.run(); console.log(`server-shutdown-lifecycle: PASS ${test.name}`); }
console.log(`server-shutdown-lifecycle: ${selected.length} groups PASS`);
