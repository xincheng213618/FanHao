import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { createServerHost } from "../src/platform/server/server-host.js";

// The actual module source is evaluated unchanged except for exposing its
// private registry constructor. Synthetic runtimes never open a DB or media.
// Host cases bind private port 0 and capture exit; no real service is contacted.
const sourcePath = path.resolve("src/fanhao/module-registry.js");
let source = fs.readFileSync(sourcePath, "utf8").replaceAll("\r\n", "\n");
const legacy = process.argv.includes("--legacy");
const selected = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
if (legacy) {
  // Restore the actual preceding methods' fail-fast behavior, leaving the
  // module's sorting, routing, settings and Host implementation unchanged.
  const methods = /  async function beginStop\(\) \{[\s\S]*?\n  \}\n\n  async function stop\(\) \{[\s\S]*?\n  \}\n\n  function publicManifest/;
  assert.ok(methods.test(source), "legacy control must locate both actual lifecycle methods");
  source = source.replace(methods, `  async function beginStop() {
    for (const entry of [...modules].reverse()) await entry.runtime.beginStop?.();
  }

  async function stop() {
    for (const entry of [...modules].reverse()) await entry.runtime.stop?.();
  }

  function publicManifest`);
}
source += "\nexport { createModuleRegistry as fixtureCreateRegistry };\n";
const { fixtureCreateRegistry } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const unexpected = [];
const onUnexpected = error => unexpected.push(error);
process.on("unhandledRejection", onUnexpected);
const outcome = promise => Promise.resolve(promise).then(value => ({ value }), error => ({ error }));
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function registry(runtimes = [{}, {}, {}]) {
  return fixtureCreateRegistry({
    modules: runtimes.map((runtime, index) => ({ definition: { id: ["novels", "short-videos", "music"][index], order: [40, 50, 60][index] }, runtime })),
    sendJson() {}
  });
}
let checks = 0;
async function run(name, verify) {
  if (selected && !name.includes(selected)) return;
  await verify(); checks++; console.log(`PASS ${name}`);
}
async function withHost(moduleRegistry, verify) {
  const calls = [], logs = [], exits = [], processRef = new EventEmitter();
  processRef.exit = code => exits.push(code);
  const host = createServerHost({
    requestHandler(req, res) { res.end(); }, port: 0, host: "127.0.0.1", networkInterfaces: () => ({}),
    getLibraryState: () => ({ availableRoots: [], missingRoots: [] }), processRef,
    logger: { log() {}, error(phase, error) { logs.push({ phase, error }); } },
    beginStop() { calls.push("beginStop"); assert.equal(host.server.listening, false, "Host stops accepting before module cancellation"); return moduleRegistry.beginStop(); },
    stop() { calls.push("stop"); return moduleRegistry.stop(); }
  });
  try {
    host.listen(); await once(host.server, "listening");
    await verify({ host, calls, logs, exits });
  } finally {
    if (host.server.listening) await new Promise(resolve => host.server.close(resolve));
    host.server.closeAllConnections();
  }
}
try {
  await run("empty-and-absent-hooks-succeed", async () => {
    for (const r of [registry([]), registry([{}, { start: async () => {} }, {}])]) {
      assert.equal(await r.beginStop(), undefined); assert.equal(await r.stop(), undefined);
    }
  });
  await run("successful-lifecycle-preserves-forward-start-and-reverse-stop", async () => {
    const calls = [];
    const r = registry([0, 1, 2].map(index => Object.fromEntries(["start", "beginStop", "stop"].map(method => [method, () => calls.push(`${method}:${index}`)]))));
    await r.start(); await r.beginStop(); await r.stop();
    assert.deepEqual(calls, ["start:0", "start:1", "start:2", "beginStop:2", "beginStop:1", "beginStop:0", "stop:2", "stop:1", "stop:0"]);
  });
  for (const method of ["beginStop", "stop"]) {
    for (const mode of ["sync", "async"]) await run(`${method}-${mode}-failure-still-cleans-lower-module`, async () => {
      const calls = [], failure = new Error(`${method} ${mode} controlled failure`);
      const r = registry([0, 1, 2].map(index => ({ [method]() {
        calls.push(index);
        if (index === 1) {
          if (mode === "sync") throw failure;
          return Promise.reject(failure);
        }
        return Promise.resolve();
      } })));
      const result = await outcome(r[method]());
      assert.equal(result.error, failure, "one failure keeps its original object");
      assert.deepEqual(calls, [2, 1, 0], "later cleanup cannot be skipped after a hook fails");
    });
    await run(`${method}-multiple-errors-preserve-all-originals-in-reverse-order`, async () => {
      const calls = [], failures = [new Error("low"), new Error("middle"), new Error("high")];
      const r = registry([0, 1, 2].map(index => ({ [method]() { calls.push(index); return Promise.reject(failures[index]); } })));
      const result = await outcome(r[method]());
      assert.deepEqual(calls, [2, 1, 0]); assert.ok(result.error instanceof AggregateError);
      assert.deepEqual(result.error.errors, [failures[2], failures[1], failures[0]]);
      assert.equal(result.error.errors[0], failures[2]); assert.equal(result.error.errors[2], failures[0]);
    });
    await run(`${method}-waits-each-hook-and-final-drain-after-earlier-error`, async () => {
      const first = deferred(), last = deferred(), calls = [], failure = new Error("middle failed");
      const r = registry([
        { async [method]() { calls.push(0); await last.promise; calls.push("closed:0"); } },
        { [method]() { calls.push(1); throw failure; } },
        { async [method]() { calls.push(2); await first.promise; calls.push("closed:2"); } }
      ]);
      let done = false;
      const task = outcome(r[method]()).then(result => { done = true; return result; });
      try {
        await tick(); assert.deepEqual(calls, [2]); assert.equal(done, false);
        first.resolve(); await tick();
        assert.deepEqual(calls, [2, "closed:2", 1, 0]); assert.equal(done, false, "failure must wait for the last cleanup's physical promise");
        last.resolve(); const result = await task;
        assert.equal(result.error, failure); assert.deepEqual(calls, [2, "closed:2", 1, 0, "closed:0"]);
      } finally { first.resolve(); last.resolve(); await task; }
    });
  }
  await run("start-retains-forward-fail-fast-contract", async () => {
    for (const mode of ["sync", "async"]) {
      const calls = [], failure = new Error("startup failed");
      const r = registry([0, 1, 2].map(index => ({ start() {
        calls.push(index); if (index !== 1) return;
        if (mode === "sync") throw failure; return Promise.reject(failure);
      } })));
      assert.equal((await outcome(r.start())).error, failure); assert.deepEqual(calls, [0, 1]);
    }
  });
  await run("actual-Host-clean-shutdown-exits-zero-after-all-module-hooks", async () => {
    const calls = [];
    const r = registry([0, 1, 2].map(index => ({ beginStop() { calls.push(`begin:${index}`); }, stop() { calls.push(`stop:${index}`); } })));
    await withHost(r, async ({ host, logs, exits }) => {
      const first = host.shutdown("private-module-lifecycle"); assert.equal(host.shutdown("duplicate"), first);
      await first; assert.deepEqual(exits, [0]); assert.deepEqual(logs, []);
      assert.deepEqual(calls, ["begin:2", "begin:1", "begin:0", "stop:2", "stop:1", "stop:0"]);
    });
  });
  await run("actual-Host-multiple-module-errors-still-clean-every-module-and-exit-one", async () => {
    const calls = [], errors = { begin: [new Error("low begin"), new Error("middle begin")], stop: [new Error("low stop"), new Error("middle stop")] };
    const r = registry([0, 1, 2].map(index => ({
      async beginStop() { calls.push(`begin:${index}`); if (index < 2) throw errors.begin[index]; },
      stop() { calls.push(`stop:${index}`); if (index < 2) throw errors.stop[index]; }
    })));
    await withHost(r, async ({ host, logs, exits, calls: phases }) => {
      await host.shutdown("private-module-errors");
      assert.deepEqual(calls, ["begin:2", "begin:1", "begin:0", "stop:2", "stop:1", "stop:0"]);
      assert.deepEqual(phases, ["beginStop", "stop"]); assert.deepEqual(exits, [1]);
      assert.deepEqual(logs.map(value => value.phase), ["[shutdown:begin]", "[shutdown:stop]"]);
      assert.ok(logs.every(value => value.error instanceof AggregateError));
      assert.deepEqual(logs[0].error.errors, [errors.begin[1], errors.begin[0]]);
      assert.deepEqual(logs[1].error.errors, [errors.stop[1], errors.stop[0]]);
    });
  });
  assert.ok(checks > 0, "selected case must exist"); assert.deepEqual(unexpected, [], "no unhandled failures");
  console.log(`Module lifecycle: ${checks} cases PASS`);
} finally { process.off("unhandledRejection", onUnexpected); }
