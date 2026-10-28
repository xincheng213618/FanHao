import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

// Reuse the controlled process/catalog boundaries of the real-media fixture,
// without executing its tests. Runtime builders, queues and lifecycle remain
// actual source; all FileHandles, hardlinks and cache publications below are
// real files under the fixture's verified temporary root. No FFmpeg or service.
const fixtureUrl = new URL("./verify_short_video_media_representation.mjs", import.meta.url);
const prefix = fs.readFileSync(fixtureUrl, "utf8").replace(/\r\n/g, "\n").split("\ntry {")[0]
  .replaceAll("import.meta.url", JSON.stringify(fixtureUrl.href))
  .replace(/from "(\.\.\/[^\"]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, fixtureUrl).href)}`);
const { fixture, deferred, tempRoot, take } = await import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport {fixture,deferred,tempRoot,take};`).toString("base64")}`);
let cases = 0;
const turn = () => new Promise(resolve => setImmediate(resolve));
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const sourceError = error => error.code === "SHORT_VIDEO_TRANSCODE_SOURCE_CHANGED" || error.code === "ENOENT";
function queue(f, kind = "current") {
  assert.equal(f.api.queueSmoothVideoCache("A", { kind }).state, "queued");
  const job = [...f.jobs.values()][0]; job.progress = {}; return job;
}
function active(f, job) { job.active = true; f.context.smoothVideoActiveJobs.set(job.key, job); }
function replaceBytes(f, { sameMtime = false } = {}) {
  const before = fs.statSync(f.file.path);
  fs.writeFileSync(f.file.path, Buffer.alloc(before.size, 88));
  fs.utimesSync(f.file.path, before.atimeMs / 1000, (before.mtimeMs + (sameMtime ? 0 : 2000)) / 1000);
  assert.equal(fs.statSync(f.file.path).size, before.size);
  return before;
}
function assertUnpublished(f, job) {
  assert.equal(fs.existsSync(job.descriptor.cachePath), false);
  assert.equal(fs.existsSync(job.descriptor.skipPath), false);
  assert.equal(f.context.smoothVideoResolvedVersions.has("A"), false);
  assert.equal(f.context.smoothVideoRenditionVersions.has("A"), false);
  assert.equal(f.context.smoothVideoCacheEntryNames.has(path.basename(job.descriptor.cachePath)), false);
  assert.equal(f.context.smoothVideoCacheEntryNames.has(path.basename(job.descriptor.skipPath)), false);
}
function trackFiles({ close = null } = {}) {
  const handles = [];
  const filesystem = { ...fs, promises: { ...fs.promises,
    async open(file, ...args) {
      const native = await fs.promises.open(file, ...args);
      const entry = { native, closed: false }; handles.push(entry);
      return { stat: () => native.stat(), async close() {
        if (close) await close(entry);
        else { await native.close(); entry.closed = true; }
      } };
    }
  } };
  return { filesystem, handles };
}
function actualResolution(f) {
  vm.runInContext(take("rememberSmoothVideoResolved"), f.context);
}

try {
  {
    const tracked = trackFiles(), f = fixture({ filesystem: tracked.filesystem });
    try {
      const job = queue(f); actualResolution(f);
      assert.equal((await f.api.buildSmoothVideoCache(job)).state, "completed");
      assert.deepEqual(fs.readFileSync(job.descriptor.cachePath), f.preferred);
      assert.equal(f.context.smoothVideoRenditionVersions.get("A"), `${f.file.size}:${f.file.cacheVersion}`);
      assert.equal(tracked.handles.length, 1); assert(tracked.handles.every(handle => handle.closed)); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      const job = queue(f); replaceBytes(f);
      await assert.rejects(f.api.buildSmoothVideoCache(job), sourceError);
      assert.equal(f.processCalls.length, 0); assert.equal(f.metadataWrites, 0); assertUnpublished(f, job); cases++;
    } finally { await f.close(); }
  }
  for (const change of ["physical", "catalog", "same-millisecond"]) {
    const f = fixture({ holdProcess: true });
    try {
      const job = queue(f), build = f.api.buildSmoothVideoCache(job); await f.processStarted.promise;
      if (change === "catalog") f.file.cacheVersion = String(Number(f.file.cacheVersion) + 1);
      else {
        // Retaining catalog's millisecond value still cannot hide ctime/inode
        // changes after the source lease has been captured.
        await turn(); replaceBytes(f, { sameMtime: change === "same-millisecond" });
        if (change === "same-millisecond") assert.equal(Math.floor(fs.statSync(f.file.path).mtimeMs), Number(f.file.cacheVersion));
      }
      f.processGate.resolve(); await assert.rejects(build, sourceError);
      assertUnpublished(f, job); assert.equal(f.metadataWrites, 0); cases++;
    } finally { await f.close(); }
  }
  {
    const gate = deferred(), reached = deferred(), f = fixture();
    let mixed;
    try {
      f.context.runMediaProcess = async (_command, args) => {
        const input = args[args.indexOf("-i") + 1], first = fs.readFileSync(input).subarray(0, 8);
        reached.resolve(); await gate.promise;
        mixed = Buffer.concat([first, fs.readFileSync(input).subarray(8)]);
        fs.writeFileSync(args.at(-1), mixed); return {};
      };
      const job = queue(f), build = f.api.buildSmoothVideoCache(job); await reached.promise;
      replaceBytes(f); gate.resolve(); await assert.rejects(build, sourceError);
      assert.deepEqual(mixed.subarray(0, 8), f.original.subarray(0, 8));
      assert.deepEqual(mixed.subarray(8), Buffer.alloc(f.original.length - 8, 88));
      assertUnpublished(f, job); cases++;
    } finally { gate.resolve(); await f.close(); }
  }
  {
    const gate = deferred(), reached = deferred();
    const f = fixture({ metadata: { actualCodec: "", actualFrameRate: 0 }, probe: () => { reached.resolve(); return gate.promise; } });
    try {
      const job = queue(f, "background"), build = f.api.buildSmoothVideoCache(job); await reached.promise;
      replaceBytes(f); gate.resolve({ codec: "h264", frameRate: 30, width: 1080, height: 1920 });
      await assert.rejects(build, sourceError); assert.equal(f.metadataWrites, 0);
      assert.equal(f.processCalls.length, 0); assertUnpublished(f, job); cases++;
    } finally { await f.close(); }
  }
  for (const stage of ["temp-stat", "rename", "skip-cleanup", "return-cleanup"]) {
    const gate = deferred(), reached = deferred(); let held = false, descriptor;
    const filesystem = { ...fs, promises: { ...fs.promises,
      async stat(file, ...args) {
        const stat = await fs.promises.stat(file, ...args);
        if (stage === "temp-stat" && String(file).includes(".tmp-") && !held) { held = true; reached.resolve(); await gate.promise; }
        return stat;
      },
      async rename(from, to) {
        await fs.promises.rename(from, to);
        if (stage === "rename" && !held) { held = true; reached.resolve(); await gate.promise; }
      },
      async rm(file, ...args) {
        await fs.promises.rm(file, ...args);
        if (!held && ((stage === "skip-cleanup" && file === descriptor?.skipPath)
          || (stage === "return-cleanup" && String(file).includes(".tmp-")))) {
          held = true; reached.resolve(); await gate.promise;
        }
      }
    } };
    const f = fixture({ filesystem });
    try {
      actualResolution(f); const job = queue(f); descriptor = job.descriptor;
      const build = f.api.buildSmoothVideoCache(job); await reached.promise;
      f.file.cacheVersion = String(Number(f.file.cacheVersion) + 1); gate.resolve();
      await assert.rejects(build, sourceError); assertUnpublished(f, job); cases++;
    } finally { gate.resolve(); await f.close(); }
  }
  for (const artifact of ["preferred", "skip"]) {
    const f = fixture({ metadata: artifact === "skip" ? { actualCodec: "", actualFrameRate: 0 } : {} });
    try {
      const job = queue(f, artifact === "skip" ? "background" : "current"), validate = f.context.validateSmoothVideoSource;
      let invalidated = false, drain;
      f.context.validateSmoothVideoSource = async (...args) => {
        await validate(...args);
        const target = artifact === "skip" ? job.descriptor.skipPath : job.descriptor.cachePath;
        if (!invalidated && fs.existsSync(target)) {
          invalidated = true;
          queueMicrotask(() => { drain = f.api.stopSmoothVideoQueue({ pause: false }); });
        }
      };
      let touches = 0; f.context.sharedCache.touch = () => touches++;
      await assert.rejects(f.api.buildSmoothVideoCache(job), { code: "SHORT_VIDEO_TRANSCODE_CANCELLED" }); await drain;
      assert.equal(invalidated, true); assert.equal(touches, 0, "caller rechecks after validation's final microtask before accepting/touching");
      assertUnpublished(f, job); cases++;
    } finally { await f.close(); }
  }
  {
    const f = fixture();
    try {
      const directory = path.join(f.root, "long-input-".repeat(14)); fs.mkdirSync(directory);
      const input = path.join(directory, "source-with-long-windows-path.mp4"); fs.renameSync(f.file.path, input); f.file.path = input;
      assert(input.length >= 240);
      f.context.roots = [f.root]; f.context.process.platform = "win32";
      vm.runInContext(`${take("createSmoothVideoInputAlias")}\n${take("cleanupSmoothVideoInputAlias")}`, f.context);
      const originalRun = f.context.runMediaProcess; let alias;
      f.context.runMediaProcess = async (command, args, options) => {
        alias = args[args.indexOf("-i") + 1]; assert.notEqual(alias, input);
        assert.equal(fs.statSync(alias).ino, fs.statSync(input).ino);
        assert.deepEqual(fs.readFileSync(alias), f.original);
        return originalRun(command, args, options);
      };
      const job = queue(f); assert.equal((await f.api.buildSmoothVideoCache(job)).state, "completed");
      assert.equal(fs.existsSync(alias), false); assert(fs.existsSync(input)); cases++;
    } finally { await f.close(); }
  }
  for (const identity of ["wrong-input", "path-replaced"]) {
    const f = fixture();
    try {
      f.context.createSmoothVideoInputAlias = async input => {
        const alias = path.join(f.root, "bound-input.mp4"), stat = fs.statSync(input);
        if (identity === "wrong-input") {
          fs.writeFileSync(alias, Buffer.alloc(stat.size, 88)); fs.utimesSync(alias, stat.atimeMs / 1000, stat.mtimeMs / 1000);
        } else {
          fs.linkSync(input, alias); fs.renameSync(input, `${input}.old`);
          fs.writeFileSync(input, Buffer.alloc(stat.size, 88)); fs.utimesSync(input, stat.atimeMs / 1000, stat.mtimeMs / 1000);
        }
        return { path: alias, dir: f.root };
      };
      const job = queue(f); await assert.rejects(f.api.buildSmoothVideoCache(job), sourceError);
      assert.equal(f.processCalls.length, 0); assertUnpublished(f, job); cases++;
    } finally { await f.close(); }
  }
  {
    const gate = deferred(), reached = deferred();
    const tracked = trackFiles({ close: async entry => { reached.resolve(); await gate.promise; await entry.native.close(); entry.closed = true; } });
    const f = fixture({ filesystem: tracked.filesystem });
    try {
      const job = queue(f); active(f, job);
      const execution = f.api.executeSmoothVideoJob(job); await reached.promise;
      let stopped = false; const stop = f.api.stopDownloadManagerSync().then(() => { stopped = true; }); await flush();
      assert.equal(stopped, false); assert.equal(f.closed, false); assert.equal(f.executions.size, 1);
      gate.resolve(); await Promise.all([execution, stop]);
      assert(tracked.handles.every(handle => handle.closed)); assert.equal(f.executions.size, 0);
      assertUnpublished(f, job); cases++;
    } finally { gate.resolve(); await f.close(); }
  }
  {
    const gate = deferred(), reached = deferred();
    const tracked = trackFiles({ close: async entry => { reached.resolve(); await gate.promise; await entry.native.close(); entry.closed = true; } });
    const f = fixture({ filesystem: tracked.filesystem });
    try {
      actualResolution(f); const job = queue(f), build = f.api.buildSmoothVideoCache(job); await reached.promise;
      replaceBytes(f); gate.resolve(); await assert.rejects(build, sourceError);
      assert(tracked.handles.every(handle => handle.closed)); assertUnpublished(f, job); cases++;
    } finally { gate.resolve(); await f.close(); }
  }
  {
    const gate = deferred(), reached = deferred();
    const f = fixture({ cleanup: async () => { reached.resolve(); await gate.promise; } });
    try {
      actualResolution(f); const job = queue(f), build = f.api.buildSmoothVideoCache(job); await reached.promise;
      f.file.cacheVersion = String(Number(f.file.cacheVersion) + 1); gate.resolve();
      await assert.rejects(build, sourceError); assertUnpublished(f, job); cases++;
    } finally { gate.resolve(); await f.close(); }
  }
  for (const failedCleanup of ["source-close", "alias-cleanup", "rollback"]) {
    const error = Object.assign(new Error(`controlled ${failedCleanup} failure`), { code: "CONTROLLED_CLEANUP_FAILURE" });
    const tracked = trackFiles({ close: failedCleanup === "source-close" ? async entry => {
      await entry.native.close(); entry.closed = true; throw error;
    } : null });
    const originalRm = tracked.filesystem.promises.rm;
    let target;
    if (failedCleanup === "rollback") tracked.filesystem.promises.rm = async (file, ...args) => {
      if (target === file && fs.existsSync(file)) throw error;
      return originalRm(file, ...args);
    };
    const f = fixture({ filesystem: tracked.filesystem, cleanup: failedCleanup === "alias-cleanup" ? async () => { throw error; } : async () => {} });
    const unhandled = []; const onUnhandled = reason => unhandled.push(reason); process.on("unhandledRejection", onUnhandled);
    try {
      const job = queue(f); target = job.descriptor.cachePath; active(f, job); actualResolution(f);
      if (failedCleanup === "rollback") {
        const validate = f.context.validateSmoothVideoSource;
        f.context.validateSmoothVideoSource = async (...args) => {
          await validate(...args);
          if (fs.existsSync(target)) queueMicrotask(() => { f.file.cacheVersion = String(Number(f.file.cacheVersion) + 1); });
        };
      }
      await f.api.executeSmoothVideoJob(job);
      assert.equal(job.drainFailure, error); assert.equal(f.executions.size, 1);
      assert.equal(f.context.smoothVideoActiveJobs.get(job.key), job);
      await turn(); assert.deepEqual(unhandled, [], "failed execution drain is observed immediately while other shutdown work is pending");
      await assert.rejects(f.api.stopDownloadManagerSync(), value => value === error);
      assert.equal(f.closed, false, "a failed source/alias/publication cleanup must not report the store safely closed");
      await assert.rejects(f.api.startDownloadManagerSync(), value => value === error);
      if (failedCleanup !== "rollback") assertUnpublished(f, job);
      assert(tracked.handles.every(handle => handle.closed)); cases++;
    } finally { process.off("unhandledRejection", onUnhandled); await f.close(); }
  }
  console.log(`short-video-transcode-source: passed ${cases} actual builder/source-lease/publication/drain cases`);
} finally {
  const resolved = path.resolve(tempRoot);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith("fanhao-media-representation-"));
  fs.rmSync(resolved, { recursive: true, force: true });
}
