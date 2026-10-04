import fs from "node:fs";
import path from "node:path";

export function createImageReaderCacheService({
  cleanupIntervalMs, cleanupTargetRatio, getMaxBytes, rootDir,
  touchThrottleMs = 30_000, warn = console.warn,
  fsOps = fs.promises, stopTimeoutMs = 2_000
}) {
  const root = path.resolve(rootDir), touches = new Map(), touchTimes = new Map();
  let inventory = new Map(), inventoryBytes = 0, exists = false, ready = false;
  let recent = [], scanning = null, cleaning = null, stopping = null, draining = null;
  let accepting = true, generation = 0, cleanupTimer = null, cleanupInterval = null;
  const scanChanges = new Map();
  const waiters = new Set();
  const stoppedError = () => Object.assign(new Error("Image reader cache is stopping"), { code: "IMAGE_READER_CACHE_STOPPED", statusCode: 503 });
  function observe(work) {
    if (!accepting) return Promise.reject(stoppedError());
    return new Promise((resolve,reject) => {
      const cancel = () => { waiters.delete(cancel); reject(stoppedError()); };
      waiters.add(cancel);
      Promise.resolve(work).then(value => { waiters.delete(cancel); resolve(value); }, error => { waiters.delete(cancel); reject(error); });
    });
  }
  const normalized = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const current = intent => accepting && intent === generation;
  const inside = value => { const relative = path.relative(root, path.resolve(value)); return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
  const identity = stat => JSON.stringify([String(stat.dev), String(stat.ino), Number(stat.size), Number(stat.mtimeMs)]);
  const names = new Intl.Collator(undefined, { numeric: true });
  const yieldLoop = () => new Promise(resolve => setImmediate(resolve));
  async function newest(entries, intent) {
    const result = []; let count = 0;
    for (const entry of entries) {
      if (!current(intent)) return [];
      result.push(entry); result.sort((a,b) => b.touchedAt - a.touchedAt); if (result.length > 12) result.pop();
      if (++count % 128 === 0) await yieldLoop();
    }
    return result;
  }
  async function oldest(entries, intent) {
    const compare = (a,b) => a.touchedAt - b.touchedAt || names.compare(a.relativePath,b.relativePath);
    let runs = [], chunk = [];
    for (const entry of entries) {
      if (!current(intent)) return [];
      chunk.push(entry);
      if (chunk.length === 512) { runs.push(chunk.sort(compare)); chunk = []; await yieldLoop(); }
    }
    if (chunk.length) runs.push(chunk.sort(compare));
    while (runs.length > 1) {
      const next = [];
      for (let run = 0; run < runs.length; run += 2) {
        if (!runs[run + 1]) { next.push(runs[run]); continue; }
        const a = runs[run], b = runs[run + 1], merged = []; let left = 0, right = 0;
        while (left < a.length || right < b.length) {
          if (!current(intent)) return [];
          merged.push(right >= b.length || (left < a.length && compare(a[left],b[right]) <= 0) ? a[left++] : b[right++]);
          if (merged.length % 1024 === 0) await yieldLoop();
        }
        next.push(merged);
      }
      runs = next;
    }
    return runs[0] || [];
  }

  async function inspect(value) {
    try { return await fsOps.lstat(value); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
  }
  async function collect(intent) {
    const rootStat = await inspect(root);
    if (!current(intent)) return;
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) { inventory = new Map(); inventoryBytes = 0; recent = []; exists = false; ready = true; return; }
    const rootIdentity = JSON.stringify([String(rootStat.dev), String(rootStat.ino)]);
    const canonicalRoot = await fsOps.realpath(root);
    if (!current(intent)) return;
    scanChanges.clear();
    const next = new Map(); let bytes = 0;
    const stack = [root];
    while (stack.length && current(intent)) {
      const directory = stack.pop();
      const directoryStat = await inspect(directory);
      if (!current(intent) || !directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) continue;
      if (normalized(await fsOps.realpath(directory)) !== normalized(path.join(canonicalRoot, path.relative(root, directory)))) continue;
      if (!current(intent)) return;
      let entries;
      try { entries = await fsOps.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      for (const item of entries) {
        if (!current(intent)) return;
        const target = path.join(directory, item.name);
        if (!inside(target) || item.isSymbolicLink()) continue;
        if (item.isDirectory()) { stack.push(target); continue; }
        if (!item.isFile() || item.name.endsWith(".tmp")) continue;
        const stat = await inspect(target);
        if (!current(intent)) return;
        if (!stat?.isFile() || stat.isSymbolicLink()) continue;
        if (normalized(await fsOps.realpath(target)) !== normalized(path.join(canonicalRoot, path.relative(root, target)))) continue;
        if (!current(intent)) return;
        const entry = { path: target, relativePath: path.relative(root, target), bytes: stat.size || 0, touchedAt: stat.mtimeMs || stat.ctimeMs || 0, identity: identity(stat) };
        next.set(target, entry); bytes += entry.bytes;
      }
    }
    let latest = await newest(next.values(), intent);
    const finalRoot = await inspect(root);
    if (!current(intent) || !finalRoot || rootIdentity !== JSON.stringify([String(finalRoot.dev), String(finalRoot.ino)]) || finalRoot.isSymbolicLink()) return;
    for (const [key, value] of scanChanges) {
      bytes -= next.get(key)?.bytes || 0;
      if (value) { next.set(key,value); bytes += value.bytes; } else next.delete(key);
      latest = latest.filter(entry => entry.path !== key);
      if (value) { latest.push(value); latest.sort((a,b) => b.touchedAt - a.touchedAt); latest = latest.slice(0,12); }
    }
    scanChanges.clear();
    inventory = next; inventoryBytes = bytes; recent = latest; exists = true; ready = true;
  }
  function refresh() {
    if (!accepting) return Promise.resolve();
    if (!scanning) {
      const intent = generation;
      const task = collect(intent);
      scanning = task;
      task.then(() => { if (scanning === task) scanning = null; }, () => { if (scanning === task) scanning = null; });
    }
    return scanning;
  }
  function status() {
    if (!ready && accepting) refresh().catch(error => warn("[image-reader-cache]", error.message || error));
    const maxBytes = getMaxBytes();
    return { root: rootDir, exists, maxBytes, currentBytes: inventoryBytes,
      overBytes: Math.max(0, inventoryBytes - maxBytes), fileCount: inventory.size,
      cleanupIntervalMs, entries: recent.map(entry => ({ relativePath: entry.relativePath, bytes: entry.bytes, touchedAt: new Date(entry.touchedAt || 0).toISOString() })) };
  }
  async function statusAsync() { await observe(!ready ? refresh() : scanning); return status(); }
  async function removeEmptyParents(filePath, intent) {
    let parent = path.dirname(filePath);
    while (current(intent) && inside(parent)) {
      try { await fsOps.rmdir(parent); } catch { return; }
      parent = path.dirname(parent);
    }
  }
  function cleanupWork(options = {}) {
    if (!accepting) return Promise.resolve({ ok: false, skipped: "stopped", status: status() });
    if (cleaning) return cleaning;
    const intent = generation;
    const task = (async () => {
      if (!ready || options.refresh || options.force) await refresh();
      if (!current(intent)) return { ok: false, skipped: "stopped", status: status() };
      const maxBytes = getMaxBytes(), ratio = Math.max(0, Math.min(1, Number(cleanupTargetRatio) || 0));
      const targetBytes = options.force ? 0 : Math.floor(maxBytes * ratio);
      const removed = []; let removedBytes = 0;
      if (options.force || inventoryBytes > maxBytes) {
        const entries = await oldest(inventory.values(), intent);
        for (const entry of entries) {
          if (!current(intent) || inventoryBytes <= targetBytes) break;
          try {
            const stat = await inspect(entry.path);
            const canonical = stat && await fsOps.realpath(entry.path);
            if (!current(intent)) break;
            if (normalized(canonical || "") !== normalized(entry.path)) continue;
            if (!stat?.isFile() || stat.isSymbolicLink() || identity(stat) !== entry.identity) continue;
            if (touches.has(entry.path) || inventory.get(entry.path) !== entry) continue;
            await fsOps.unlink(entry.path);
            inventory.delete(entry.path); inventoryBytes -= entry.bytes; touchTimes.delete(entry.path);
            if (scanning) scanChanges.set(entry.path,null);
            removedBytes += entry.bytes; removed.push({ relativePath: entry.relativePath, bytes: entry.bytes });
            await removeEmptyParents(entry.path, intent);
          } catch (error) { warn("[image-reader-cache-cleanup]", entry.path, error.message || error); }
        }
        const candidates = await newest(inventory.values(), intent);
        if (current(intent)) {
          const latest = new Map([...candidates, ...recent].filter(entry => inventory.get(entry.path) === entry).map(entry => [entry.path,entry]));
          recent = [...latest.values()].sort((a,b) => b.touchedAt - a.touchedAt).slice(0,12);
        }
      }
      return { ok: true, maxBytes, targetBytes, removedCount: removed.length, removedBytes, removed, status: status() };
    })();
    cleaning = task; task.then(() => { if (cleaning === task) cleaning = null; }, () => { if (cleaning === task) cleaning = null; });
    return task;
  }
  function cleanup(options = {}) { return observe(cleanupWork(options)); }
  function scheduleCleanup() {
    if (!accepting || cleanupTimer) return;
    cleanupTimer = setTimeout(() => { cleanupTimer = null; cleanup().catch(error => warn("[image-reader-cache-cleanup]", error.message || error)); },1000);
    cleanupTimer.unref?.();
  }
  function startCleanupTimer() {
    if (!accepting || cleanupInterval) return;
    const configured = Number(cleanupIntervalMs);
    const delay = Number.isFinite(configured) ? Math.max(1000, Math.min(2_147_483_647, configured || 60_000)) : 60_000;
    cleanupInterval = setInterval(() => cleanup({ refresh: true }).catch(error => warn("[image-reader-cache-cleanup]", error.message || error)), delay);
    cleanupInterval.unref?.(); scheduleCleanup();
  }
  function touch(filePath) {
    const key = path.resolve(filePath), now = Date.now();
    if (!accepting || !inside(key)) return Promise.resolve(false);
    if (touches.has(key)) return touches.get(key);
    if (now - (touchTimes.get(key) || 0) < touchThrottleMs) return Promise.resolve(true);
    if (touches.size >= 128) return Promise.resolve(false);
    const intent = generation;
    const task = (async () => {
      const before = await inspect(key);
      if (!current(intent) || !before?.isFile() || before.isSymbolicLink()) return false;
      const rootStat = await inspect(root);
      if (!current(intent) || !rootStat?.isDirectory() || rootStat.isSymbolicLink()) return false;
      const canonicalRoot = await fsOps.realpath(root), canonicalFile = await fsOps.realpath(key);
      if (!current(intent) || normalized(canonicalFile) !== normalized(path.join(canonicalRoot,path.relative(root,key)))) return false;
      const date = new Date(now); await fsOps.utimes(key, date, date);
      const after = await inspect(key);
      if (!current(intent) || !after?.isFile() || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino)) return false;
      const previous = inventory.get(key), entry = { path: key, relativePath: path.relative(root,key), bytes: after.size || 0, touchedAt: now, identity: identity(after) };
      if (ready) { inventory.set(key,entry); inventoryBytes += entry.bytes - (previous?.bytes || 0); recent = [entry, ...recent.filter(value => value.path !== key)].sort((a,b) => b.touchedAt - a.touchedAt).slice(0,12); }
      if (scanning) scanChanges.set(key,entry);
      touchTimes.delete(key); touchTimes.set(key,now);
      if (touchTimes.size > 4096) touchTimes.delete(touchTimes.keys().next().value);
      return true;
    })().catch(error => { warn("[image-reader-cache-touch]", error.message || error); return false; });
    touches.set(key,task); task.finally(() => { if (touches.get(key) === task) touches.delete(key); }); return task;
  }
  function beginStop() {
    accepting = false; generation++;
    for (const cancel of [...waiters]) cancel();
    clearTimeout(cleanupTimer); clearInterval(cleanupInterval); cleanupTimer = null; cleanupInterval = null;
  }
  function stop() {
    beginStop();
    if (!stopping) {
      draining = Promise.allSettled([scanning, cleaning, ...touches.values()].filter(Boolean));
      let timer;
      const delay = Number.isFinite(Number(stopTimeoutMs)) ? Math.max(1, Math.min(60_000, Number(stopTimeoutMs))) : 2_000;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Image reader cache operations have not settled"), { code: "IMAGE_READER_CACHE_STOP_INCOMPLETE", statusCode: 503 })), delay); });
      stopping = Promise.race([draining, deadline]).finally(() => clearTimeout(timer));
    }
    return stopping;
  }
  async function start({ backgroundInventory = false } = {}) {
    const intent = ++generation;
    if (stopping) { if (scanning || cleaning || touches.size) await stopping; else await draining; }
    if (intent !== generation) throw Object.assign(new Error("Image reader cache is stopping"), { statusCode: 503 });
    stopping = null; draining = null; accepting = true;
    if (backgroundInventory) refresh().catch(error => warn("[image-reader-cache]",error.message || error));
    else await observe(refresh());
    if (intent !== generation) throw Object.assign(new Error("Image reader cache is stopping"), { statusCode: 503 });
    startCleanupTimer();
  }
  return { rootDir, status, statusAsync, cleanup, scheduleCleanup, startCleanupTimer, touch, start, beginStop, stop,
    diagnostics: () => ({ accepting, scanning: Boolean(scanning), cleaning: Boolean(cleaning), touches: touches.size, timerPending: Boolean(cleanupTimer), intervalActive: Boolean(cleanupInterval) }) };
}
