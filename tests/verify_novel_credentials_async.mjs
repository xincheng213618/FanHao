import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createNovelCredentialService } from "../src/modules/novels/server/credential-service.js";
import { createNovelSettingsProvider } from "../src/modules/novels/server/settings.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-credential-probe-"));
const services = [];
const children = [];
const controlledChildren = [];
const cookie = "server_name_session=fixture_only; lf_user_auth=fixture; lf_user_auth_sign=fixture";
const immediate = () => new Promise((resolve) => setImmediate(resolve));
let index = 0;
let server;
const unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);

function fixture(options = {}) {
  const credentialRoot = path.join(temporary, String(++index));
  const calls = [];
  const service = createNovelCredentialService({
    credentialRoot, probePath: path.join(temporary, "unused-probe.py"), ...options,
    spawnProcess: options.spawnProcess || ((_command, args, settings) => {
      assert.equal(settings.windowsHide, true);
      assert(!args.join(" ").includes(cookie), "credentials must travel by the existing private path, not argv");
      const child = new EventEmitter();
      Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, closed: false });
      child.kill = (signal) => { child.killed = true; assert.equal(signal, "SIGKILL"); };
      child.finish = (output = '{"ok":true,"message":"fixture"}', status = 0) => {
        child.closed = true;
        if (output) child.stdout.emit("data", Buffer.from(output));
        child.emit("close", status);
      };
      calls.push(child);
      controlledChildren.push(child);
      return child;
    })
  });
  services.push(service);
  service.saveAliceswCookie(cookie);
  return { service, calls, credentialRoot };
}

try {
  const f = fixture();
  const settings = createNovelSettingsProvider({ credentialService: f.service });
  const first = settings.action("test-alicesw-cookie", { url: "https://alicesw.com/book#fragment", signal: {} });
  let settled = false;
  first.then(() => { settled = true; });
  await immediate();
  assert.equal(settled, false);
  assert.match((await f.service.testAliceswCookie()).error, /正在运行/);
  assert.equal(f.calls.length, 1, "concurrent probes must have bounded process ownership");
  f.calls[0].finish();
  assert.equal((await first).ok, true);
  await assert.rejects(f.service.testAliceswCookie({ url: "https://example.invalid" }), (error) => error.statusCode === 400);

  for (const reason of ["cancel", "timeout", "size", "error", "pipe-error", "save", "clear", "stop"]) {
    const f = fixture({ probeTimeoutMs: reason === "timeout" ? 5 : 1000, maxProbeBytes: 64 });
    const controller = new AbortController();
    const pending = f.service.testAliceswCookie({ signal: controller.signal });
    let settled = false;
    pending.then(() => { settled = true; });
    const child = f.calls[0];
    let stopping;
    if (reason === "cancel") controller.abort();
    if (reason === "timeout") await new Promise((resolve) => setTimeout(resolve, 12));
    if (reason === "size") child.stdout.emit("data", Buffer.alloc(65));
    if (reason === "error") child.emit("error", new Error("controlled startup failure"));
    if (reason === "pipe-error") child.stderr.emit("error", new Error("controlled stream failure"));
    if (reason === "save") f.service.saveAliceswCookie(cookie + "; new=fixture");
    if (reason === "clear") f.service.clearAliceswCookie();
    if (reason === "stop") stopping = f.service.stop();
    await immediate();
    assert.equal(child.killed, true, `${reason} must terminate its child`);
    assert.equal(settled, false, `${reason} must await child close before admitting another probe`);
    child.finish();
    assert.equal((await pending).ok, false, `${reason} must not accept a late successful result`);
    if (stopping) {
      await stopping;
      assert.match((await f.service.testAliceswCookie()).error, /停止/);
      await f.service.start();
      const next = f.service.testAliceswCookie(); f.calls[1].finish(); assert.equal((await next).ok, true);
    }
  }

  const lifecycle = fixture();
  const pendingProbe = lifecycle.service.testAliceswCookie();
  const firstStop = lifecycle.service.beginStop();
  const staleStart = lifecycle.service.start();
  const latestStop = lifecycle.service.stop();
  lifecycle.calls[0].finish();
  assert.equal((await pendingProbe).ok, false);
  await Promise.all([firstStop, latestStop]);
  assert.equal(await staleStart, false, "a newer stop must supersede a start waiting for the old child");
  assert.match((await lifecycle.service.testAliceswCookie()).error, /停止/);
  assert.equal(lifecycle.calls.length, 1, "stale start must not admit another child after stop completes");
  assert.equal(await lifecycle.service.start(), true);
  const freshProbe = lifecycle.service.testAliceswCookie();
  lifecycle.calls[1].finish();
  assert.equal((await freshProbe).ok, true, "a fresh explicit start can reopen the stopped service");

  const changed = fixture();
  const stale = changed.service.testAliceswCookie();
  fs.writeFileSync(path.join(changed.credentialRoot, "alicesw-cookie.txt"), cookie.replace("fixture_only", "fixture_new_"));
  changed.calls[0].finish();
  assert.match((await stale).error, /已变化/);
  fs.writeFileSync(path.join(changed.credentialRoot, "alicesw-cookie.txt"), "x".repeat(128 * 1024 + 1));
  assert.equal(changed.service.aliceswStatus().configured, false, "manually oversized credential files must not be synchronously loaded");

  const throws = fixture({ spawnProcess: () => { throw new Error("controlled launch failure"); } });
  assert.equal((await throws.service.testAliceswCookie()).ok, false);
  const missing = fixture({ pythonPath: path.join(temporary, "missing-executable.exe"), spawnProcess: spawn });
  assert.equal((await missing.service.testAliceswCookie()).ok, false, "real ENOENT must settle through the child close path");

  // A real, local Node child stands in for Python. It neither opens the cookie
  // nor performs network I/O; this verifies actual process and HTTP scheduling.
  let childReady;
  const ready = new Promise((resolve) => { childReady = resolve; });
  const real = fixture({ probeTimeoutMs: 2000, spawnProcess: (_command, args, options) => {
    assert.equal(args[args.indexOf("--cookie-file") + 1], path.join(temporary, String(index), "alicesw-cookie.txt"));
    const child = spawn(process.execPath, ["-e", "console.log('ready'); setTimeout(() => console.log(JSON.stringify({ok:true,message:'local fixture'})), 200)"], options);
    children.push(child);
    child.stdout.on("data", () => childReady());
    return child;
  } });
  const realSettings = createNovelSettingsProvider({ credentialService: real.service });
  server = http.createServer(async (req, res) => {
    const data = req.url === "/health" ? { ok: true } : await realSettings.action("test-alicesw-cookie");
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let replied = false;
  const request = fetch(`${base}/test`, { method: "POST" }).then(async (res) => { replied = true; return res.json(); });
  await ready;
  assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
  assert.equal(replied, false, "health must respond while the real probe child is running");
  assert.equal((await request).ok, true);
  await real.service.stop();
  assert(children.every((child) => child.exitCode !== null || child.signalCode !== null));
  await immediate(); assert.deepEqual(unhandled, []);
  console.log("novel-credentials-async: ok (HTTP responsiveness, bounded real/controlled children, cancellation, timeout, output limits, source changes and stop)");
} finally {
  for (const child of controlledChildren) if (!child.closed) child.finish(null, null);
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const service of services) await service.stop();
  process.off("unhandledRejection", onUnhandled);
  for (let folder = 1; folder <= index; folder++) {
    const directory = path.join(temporary, String(folder));
    const file = path.join(directory, "alicesw-cookie.txt");
    if (fs.existsSync(file)) fs.unlinkSync(file);
    if (fs.existsSync(directory)) fs.rmdirSync(directory);
  }
  fs.rmdirSync(temporary);
}
