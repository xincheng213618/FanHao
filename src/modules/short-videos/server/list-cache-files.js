import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { boundedInteger } from "../../../platform/server/local-image-read-queue.js";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const FILE_NAME = /^[a-f0-9]{40}\.json$/u;
const extraReadFlags = (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
const readFlags = extraReadFlags ? fs.constants.O_RDONLY | extraReadFlags : "r";

export function createShortVideoListCacheFiles({
  rootDir, fsOps = fs.promises, concurrency = 4, capacity = 36,
  maxBytes = DEFAULT_MAX_BYTES, touch, warn = console.warn
}) {
  const root = path.resolve(rootDir);
  const namespace = path.join(root, "short-videos");
  const directory = path.join(namespace, "lists");
  concurrency = boundedInteger(concurrency, 4, 1, 16);
  capacity = boundedInteger(capacity, 36, concurrency, 512);
  maxBytes = boundedInteger(maxBytes, DEFAULT_MAX_BYTES, 1, 64 * 1024 * 1024);
  const queue = [], running = new Map();
  let accepting = true, stopping = null, stopGeneration = 0, waiterCount = 0;

  function cachePath(filePath) {
    if (typeof filePath !== "string") return null;
    const absolute = path.resolve(filePath), name = path.basename(absolute);
    return FILE_NAME.test(name) && path.relative(directory, path.dirname(absolute)) === ""
      ? path.join(directory, name) : null;
  }

  function unsafePath() {
    return new Error("Short-video list cache path is outside its owned directory or contains a link");
  }

  const sameIdentity = (left, right) => Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
  const sameRevision = (left, right) => sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs;
  const samePath = (left, right) => path.relative(left, right) === "";

  async function inspect(filePath) {
    try { return await fsOps.lstat(filePath); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
  }

  async function directorySnapshot(create = false, isCurrent = () => true) {
    let canonicalRoot;
    const entries = [];
    for (const location of [root, namespace, directory]) {
      if (!isCurrent()) return null;
      let stat = await inspect(location);
      if (!stat && create && isCurrent()) {
        try { await fsOps.mkdir(location, { recursive: location === root }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
        stat = await inspect(location);
      }
      if (!stat) return null;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafePath();
      if (location === root) {
        canonicalRoot = await fsOps.realpath(root);
        const confirmed = await inspect(root);
        if (!sameIdentity(stat, confirmed) || !confirmed.isDirectory() || confirmed.isSymbolicLink()) throw unsafePath();
      } else if (create && !samePath(await fsOps.realpath(location), path.join(canonicalRoot, path.relative(root, location)))) {
        // Check each new parent before possibly creating the next component.
        throw unsafePath();
      }
      entries.push(stat);
    }
    return { canonical: path.join(canonicalRoot, "short-videos", "lists"), entries };
  }

  function sameDirectory(before, after) {
    return Boolean(after && samePath(before.canonical, after.canonical)
      && before.entries.every((entry, index) => sameIdentity(entry, after.entries[index])));
  }

  async function fileSnapshot(filePath, owner) {
    const stat = await inspect(filePath);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink()
        || !samePath(await fsOps.realpath(filePath), path.join(owner.canonical, path.basename(filePath)))) throw unsafePath();
    return stat;
  }

  async function touchCurrent(filePath, isCurrent) {
    if (!touch || !isCurrent()) return;
    try { await touch(filePath); } catch { /* Cache use does not depend on its eviction timestamp. */ }
  }

  async function readFile(filePath, isCurrent) {
    const owner = await directorySnapshot(false, isCurrent);
    if (!owner || !isCurrent()) return null;
    const before = await fileSnapshot(filePath, owner);
    if (!before || !isCurrent() || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxBytes) return null;

    let data;
    const handle = await fsOps.open(filePath, readFlags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameRevision(before, opened) || !isCurrent()) return null;

      // Read one extra byte to reject growth and bound both allocation and I/O.
      const buffer = Buffer.allocUnsafe(opened.size + 1);
      let length = 0;
      while (length < buffer.length && isCurrent()) {
        const { bytesRead } = await handle.read(buffer, length, Math.min(READ_CHUNK_BYTES, buffer.length - length), length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== opened.size || !isCurrent() || !sameRevision(opened, await handle.stat())
          || !sameRevision(opened, await fileSnapshot(filePath, owner)) || !isCurrent()) return null;
      data = JSON.parse(buffer.toString("utf8", 0, length));
    } finally {
      await handle.close();
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    await touchCurrent(filePath, isCurrent);
    return isCurrent() ? data : null;
  }

  async function writeFile(filePath, payload, isCurrent) {
    const body = JSON.stringify(payload);
    if (typeof body !== "string") return false;
    const size = Buffer.byteLength(body);
    if (size > maxBytes) return false;
    const owner = await directorySnapshot(true, isCurrent);
    if (!owner || !isCurrent()) return false;
    await fileSnapshot(filePath, owner);
    if (!isCurrent()) return false;

    const stage = `${filePath}.${randomUUID()}.tmp`;
    let handle, stageIdentity, created = false;
    try {
      handle = await fsOps.open(stage, "wx");
      created = true;
      stageIdentity = await handle.stat();
      if (!stageIdentity.isFile() || !sameDirectory(owner, await directorySnapshot())
          || !sameIdentity(stageIdentity, await fileSnapshot(stage, owner)) || !isCurrent()) return false;
      await handle.writeFile(body, "utf8");
      const written = await handle.stat();
      await handle.close();
      handle = null;
      if (written.size !== size || !sameIdentity(stageIdentity, written) || !isCurrent()
          || !sameDirectory(owner, await directorySnapshot())
          || !sameRevision(written, await fileSnapshot(stage, owner))) return false;
      await fileSnapshot(filePath, owner);
      if (!sameDirectory(owner, await directorySnapshot()) || !isCurrent()) return false;

      // The existing cache remains readable until this single atomic replace.
      await fsOps.rename(stage, filePath);
      created = false;
      await touchCurrent(filePath, isCurrent);
      return isCurrent();
    } finally {
      try { await handle?.close(); }
      finally {
        if (created) {
          try {
            if (sameDirectory(owner, await directorySnapshot())) {
              const leftover = await fileSnapshot(stage, owner);
              if (leftover && (!stageIdentity || sameIdentity(stageIdentity, leftover))) await fsOps.unlink(stage);
            }
          } catch (error) {
            if (error.code !== "ENOENT") warn("[short-video-list-cache-stage]", error.message || error);
          }
        }
      }
    }
  }

  function settle(task, value) {
    for (const waiter of task.waiters) waiter(value);
  }

  function join(task, signal) {
    return new Promise(resolve => {
      const finish = value => {
        if (!task.waiters.delete(finish)) return;
        waiterCount--;
        signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const abort = () => {
        finish(task.fallback);
        if (task.waiters.size) return;
        task.retired = true;
        const index = queue.indexOf(task);
        if (index >= 0) queue.splice(index, 1);
        pump();
      };
      task.waiters.add(finish);
      waiterCount++;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  function pump() {
    while (accepting && running.size < concurrency) {
      const index = queue.findIndex(task => !running.has(task.filePath));
      if (index < 0) return;
      const [task] = queue.splice(index, 1);
      running.set(task.filePath, task);
      const isCurrent = () => accepting && !task.retired && task.isCurrent();
      task.done = Promise.resolve().then(async () => {
        let value = task.fallback;
        try {
          if (isCurrent()) value = await task.run(isCurrent);
          if (!isCurrent()) value = task.fallback;
        } catch (error) {
          value = task.fallback;
          if (!task.read && isCurrent()) warn("[short-video-list-cache]", error.message || error);
        } finally {
          running.delete(task.filePath);
          settle(task, value);
          pump();
        }
      });
    }
  }

  function submit(filePath, read, run, { signal, isCurrent = () => true } = {}) {
    const fallback = read ? null : false;
    if (!filePath || !accepting || signal?.aborted || waiterCount >= capacity * 8) return Promise.resolve(fallback);
    const previous = queue.findLast(task => task.filePath === filePath) || running.get(filePath);
    if (read && previous?.read && !previous.retired) return join(previous, signal);
    if (running.size + queue.length >= capacity) return Promise.resolve(fallback);
    const task = { filePath, read, run, isCurrent, fallback, waiters: new Set() };
    queue.push(task);
    const result = join(task, signal);
    pump();
    return result;
  }

  function read(filePath, options) {
    const target = cachePath(filePath);
    return submit(target, true, isCurrent => readFile(target, isCurrent), options);
  }

  function write(filePath, payload, options) {
    const target = cachePath(filePath);
    return submit(target, false, isCurrent => writeFile(target, payload, isCurrent), options);
  }

  function stop() {
    accepting = false;
    stopGeneration++;
    for (const task of queue.splice(0)) settle(task, task.fallback);
    stopping ??= Promise.all([...running.values()].map(task => task.done)).then(() => undefined);
    return stopping;
  }

  function start() {
    if (accepting) return true;
    const generation = stopGeneration;
    const reopen = () => {
      if (generation !== stopGeneration) return false;
      stopping = null;
      accepting = true;
      return true;
    };
    return running.size ? stopping.then(reopen) : reopen();
  }

  return { read, write, stop, start };
}
