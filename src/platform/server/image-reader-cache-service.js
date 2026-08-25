import fs from "node:fs";
import path from "node:path";

export function createImageReaderCacheService({
  cleanupIntervalMs,
  cleanupTargetRatio,
  getMaxBytes,
  rootDir,
  safeStat,
  touchThrottleMs,
  warn = console.warn
}) {
  const touchTimes = new Map();
  let inventory = null;
  let inventoryBytes = 0;
  let cleanupPending = false;
  let cleanupActive = false;

  function collectEntries() {
    const root = path.resolve(rootDir);
    const entries = [];
    const stack = [root];
    if (!safeStat(root)?.isDirectory()) return entries;

    while (stack.length) {
      const current = stack.pop();
      let dirEntries = [];
      try {
        dirEntries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of dirEntries) {
        const fullPath = path.join(current, entry.name);
        const relative = path.relative(root, fullPath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (entry.isFile()) {
          const stat = safeStat(fullPath);
          entries.push({
            path: fullPath,
            relativePath: relative,
            bytes: stat?.size || 0,
            touchedAt: stat?.mtimeMs || stat?.ctimeMs || 0
          });
        }
      }
    }
    return entries;
  }

  function inventoryEntries({ refresh = false } = {}) {
    if (!inventory || refresh) {
      const entries = collectEntries();
      inventory = new Map(entries.map((entry) => [entry.path, entry]));
      inventoryBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    }
    return [...inventory.values()];
  }

  function oldestFirst(entries) {
    return entries.sort((a, b) => a.touchedAt - b.touchedAt || a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));
  }

  function removeEmptyParents(filePath) {
    const root = path.resolve(rootDir);
    let current = path.dirname(path.resolve(filePath));
    while (current.startsWith(root) && current !== root) {
      try {
        if (fs.readdirSync(current).length) break;
        fs.rmdirSync(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }

  function status() {
    const entries = oldestFirst(inventoryEntries());
    const maxBytes = getMaxBytes();
    return {
      root: rootDir,
      exists: Boolean(safeStat(rootDir)?.isDirectory()),
      maxBytes,
      currentBytes: inventoryBytes,
      overBytes: Math.max(0, inventoryBytes - maxBytes),
      fileCount: entries.length,
      cleanupIntervalMs,
      entries: entries.slice(-12).reverse().map((entry) => ({
        relativePath: entry.relativePath,
        bytes: entry.bytes,
        touchedAt: new Date(entry.touchedAt || 0).toISOString()
      }))
    };
  }

  function cleanup(options = {}) {
    if (cleanupActive) {
      return { ok: false, skipped: "active", status: status() };
    }
    cleanupActive = true;
    try {
      const maxBytes = getMaxBytes();
      const entries = oldestFirst(inventoryEntries({ refresh: Boolean(options.refresh) }));
      let currentBytes = inventoryBytes;
      const targetBytes = options.force ? 0 : Math.floor(maxBytes * cleanupTargetRatio);
      const removed = [];
      let removedBytes = 0;

      if (options.force || currentBytes > maxBytes) {
        for (const entry of entries) {
          if (currentBytes <= targetBytes) break;
          try {
            fs.rmSync(entry.path, { force: true });
            removeEmptyParents(entry.path);
            currentBytes -= entry.bytes;
            inventory.delete(entry.path);
            inventoryBytes = currentBytes;
            touchTimes.delete(entry.path);
            removedBytes += entry.bytes;
            removed.push({ relativePath: entry.relativePath, bytes: entry.bytes });
          } catch (error) {
            warn("[image-reader-cache-cleanup]", entry.path, error.message || error);
          }
        }
      }

      return {
        ok: true,
        maxBytes,
        targetBytes,
        removedCount: removed.length,
        removedBytes,
        removed,
        status: status()
      };
    } finally {
      cleanupActive = false;
    }
  }

  function scheduleCleanup() {
    if (cleanupPending) return;
    cleanupPending = true;
    setTimeout(() => {
      cleanupPending = false;
      try {
        cleanup();
      } catch (error) {
        warn("[image-reader-cache-cleanup]", error.message || error);
      }
    }, 1000);
  }

  function startCleanupTimer() {
    setInterval(() => {
      try {
        cleanup({ refresh: true });
      } catch (error) {
        warn("[image-reader-cache-cleanup]", error.message || error);
      }
    }, cleanupIntervalMs).unref?.();
    scheduleCleanup();
  }

  function touch(filePath) {
    const now = Date.now();
    const key = path.resolve(filePath);
    if (now - (touchTimes.get(key) || 0) < touchThrottleMs) return;
    touchTimes.set(key, now);
    try {
      const date = new Date(now);
      fs.utimesSync(filePath, date, date);
      if (inventory) {
        const root = path.resolve(rootDir);
        const relativePath = path.relative(root, key);
        const stat = safeStat(key);
        if (stat?.isFile() && relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
          const previous = inventory.get(key);
          const entry = { path: key, relativePath, bytes: stat.size || 0, touchedAt: now };
          inventory.set(key, entry);
          inventoryBytes += entry.bytes - (previous?.bytes || 0);
        }
      }
    } catch {}
  }

  return {
    cleanup,
    rootDir,
    scheduleCleanup,
    startCleanupTimer,
    status,
    touch
  };
}
