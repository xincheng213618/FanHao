import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

const DEFAULT_TREE_LIMIT = 1400;
const MAX_TREE_LIMIT = 4000;
const MAX_SEARCH_LIMIT = 200;
const TREEMAP_CHILD_LIMIT = 320;
const TREEMAP_MAX_DEPTH = 7;
const TREEMAP_NODE_BUDGET = 12000;

export function createDiskUsageStore({ cacheDir, excludedNames = [], sources = [], warn = console.warn } = {}) {
  const drives = createDriveCatalog(sources);
  const drivesById = new Map(drives.map((drive) => [drive.id, drive]));
  const lastTasks = new Map();
  let active = null;
  let stopping = false;

  function start() {
    fs.mkdirSync(cacheDir, { recursive: true });
    cleanupInterruptedCaches();
  }

  function beginStop() {
    stopping = true;
  }

  async function stop() {
    stopping = true;
    const worker = active?.worker;
    active = null;
    if (worker) await worker.terminate().catch(() => {});
  }

  function summary() {
    return {
      cacheOnly: true,
      drives: drives.map((drive) => driveSummary(drive)),
      generatedAt: new Date().toISOString(),
      scanning: Boolean(active)
    };
  }

  function status() {
    return {
      active: active ? publicTask(active) : null,
      tasks: drives.map((drive) => lastTasks.get(drive.id)).filter(Boolean).map(publicTask)
    };
  }

  function tree(driveId, requestedPath, requestedLimit, requestedDepth = 1) {
    const drive = requireDrive(driveId);
    const targetPath = normalizeTargetPath(drive, requestedPath || drive.root);
    const manifest = readManifest(drive);
    if (!manifest) return { cache: null, children: [], drive: publicDrive(drive), node: null };
    const limit = clampInteger(requestedLimit, DEFAULT_TREE_LIMIT, 1, MAX_TREE_LIMIT);
    return withCacheDatabase(drive, manifest, (database) => {
      const node = database.prepare("SELECT * FROM nodes WHERE path = ?").get(targetPath);
      if (!node) throw publicError("缓存中没有这个路径，请手动刷新磁盘缓存", 404);
      if (!node.is_directory) throw publicError("该路径不是文件夹", 400);
      const children = database.prepare(`
        SELECT * FROM nodes
        WHERE parent_path = ?
        ORDER BY size_bytes DESC, is_directory DESC, name COLLATE NOCASE
        LIMIT ?
      `).all(targetPath, limit + 1);
      let visible = children.slice(0, limit).map(publicNode);
      if (Number(requestedDepth) >= 2) {
        visible = attachTreemapDescendants(database, visible, node, requestedDepth);
      }
      const hiddenCount = Math.max(0, children.length - visible.length);
      return {
        cache: publicManifest(manifest),
        children: visible,
        drive: publicDrive(drive),
        hiddenCount,
        node: publicNode(node),
        path: targetPath
      };
    });
  }

  function attachTreemapDescendants(database, topNodes, parentRow, requestedDepth) {
    const statement = database.prepare(`
      SELECT * FROM nodes
      WHERE parent_path = ?
      ORDER BY size_bytes DESC, is_directory DESC, name COLLATE NOCASE
      LIMIT ?
    `);
    const parentSize = Math.max(1, Number(parentRow.size_bytes || 0));
    const maxDepth = clampInteger(requestedDepth, TREEMAP_MAX_DEPTH, 2, TREEMAP_MAX_DEPTH);
    let budget = TREEMAP_NODE_BUDGET;
    const queue = topNodes
      .filter((node) => node.isDirectory && node.size > 0)
      .map((node) => ({ level: 1, node }))
      .sort(compareTreemapCandidates);

    while (queue.length && budget > 0) {
      const candidate = queue.shift();
      const node = candidate.node;
      if (candidate.level >= maxDepth || node.size / parentSize < 0.00001) continue;
      const limit = Math.min(TREEMAP_CHILD_LIMIT, budget);
      const rows = statement.all(node.path, limit + 1);
      const visibleRows = rows.slice(0, limit).map(publicNode);
      budget -= visibleRows.length;
      if (!visibleRows.length) continue;
      const visibleBytes = visibleRows.reduce((sum, child) => sum + child.size, 0);
      const hiddenBytes = Math.max(0, node.size - visibleBytes);
      const hiddenCount = Math.max(0, node.fileCount + node.directoryCount - visibleRows.length);
      if (hiddenBytes > 0) {
        visibleRows.push({
          aggregate: true,
          aggregateCount: hiddenCount,
          depth: node.depth + 1,
          directoryCount: 0,
          errorCount: 0,
          extension: "",
          fileCount: hiddenCount,
          isDirectory: true,
          modifiedMs: 0,
          name: hiddenCount ? `其他 ${hiddenCount} 项` : "其他",
          parentPath: node.path,
          path: node.path,
          size: hiddenBytes
        });
      }
      node.treemapChildren = visibleRows;
      for (const child of visibleRows) {
        if (!child.aggregate && child.isDirectory && child.size > 0) {
          insertTreemapCandidate(queue, { level: candidate.level + 1, node: child });
        }
      }
    }
    return topNodes;
  }

  function search(driveId, rawQuery, requestedLimit) {
    const drive = requireDrive(driveId);
    const query = String(rawQuery || "").trim();
    if (query.length < 2) return { drive: publicDrive(drive), items: [], query };
    const manifest = readManifest(drive);
    if (!manifest) return { drive: publicDrive(drive), items: [], query };
    const limit = clampInteger(requestedLimit, 80, 1, MAX_SEARCH_LIMIT);
    return withCacheDatabase(drive, manifest, (database) => ({
      cache: publicManifest(manifest),
      drive: publicDrive(drive),
      items: database.prepare(`
        SELECT * FROM nodes
        WHERE name LIKE ? ESCAPE '\\'
        ORDER BY size_bytes DESC, name COLLATE NOCASE
        LIMIT ?
      `).all(`%${escapeLike(query)}%`, limit).map(publicNode),
      query
    }));
  }

  function cachedNode(driveId, requestedPath) {
    const drive = requireDrive(driveId);
    const targetPath = normalizeTargetPath(drive, requestedPath);
    const manifest = readManifest(drive);
    if (!manifest && targetPath === drive.root) {
      return {
        drive,
        manifest: null,
        node: {
          depth: 0,
          directoryCount: 0,
          errorCount: 0,
          extension: "",
          fileCount: 0,
          isDirectory: true,
          modifiedMs: 0,
          name: drive.name,
          parentPath: "",
          path: drive.root,
          size: 0
        }
      };
    }
    if (!manifest) throw publicError("该磁盘还没有缓存，请先手动刷新", 404);
    return withCacheDatabase(drive, manifest, (database) => {
      const row = database.prepare("SELECT * FROM nodes WHERE path = ?").get(targetPath);
      if (!row) throw publicError("缓存中没有这个路径，请手动刷新磁盘缓存", 404);
      return { drive, manifest, node: publicNode(row) };
    });
  }

  function refresh(driveId) {
    if (stopping) throw publicError("服务正在停止，暂时不能扫描", 503);
    if (active) throw publicError(`正在扫描 ${active.drive.name}，请完成后再刷新其他磁盘`, 409);
    const drive = requireDrive(driveId);
    if (!fs.statSync(drive.root, { throwIfNoEntry: false })?.isDirectory()) {
      throw publicError(`磁盘 ${drive.name} 当前不可访问`, 404);
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    cleanupDriveCaches(drive);
    const scanId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const outputPath = path.join(cacheDir, `${drive.id.toLocaleLowerCase("en-US")}-${scanId}.sqlite`);
    const worker = new Worker(new URL("./scan-worker.js", import.meta.url), {
      workerData: {
        allowedLinkedRoots: [...(drive.linkedRoots || [])],
        excludedNames: [...excludedNames],
        outputPath,
        root: drive.root,
        scanId
      }
    });
    const task = {
      drive,
      error: "",
      outputPath,
      progress: { bytes: 0, currentPath: drive.root, directories: 0, errors: 0, files: 0, nodes: 0, skipped: 0 },
      scanId,
      startedAt: new Date().toISOString(),
      state: "scanning",
      worker
    };
    active = task;
    lastTasks.set(drive.id, task);

    worker.on("message", (message) => {
      if (message?.type === "progress") {
        task.progress = { ...task.progress, ...message.progress };
        return;
      }
      if (message?.type === "complete") publishCompletedScan(task, message.result);
      if (message?.type === "failed") failTask(task, message.error);
    });
    worker.once("error", (error) => failTask(task, error?.message || error));
    worker.once("exit", (code) => {
      if (code !== 0 && ["scanning", "publishing"].includes(task.state)) failTask(task, `扫描线程异常退出（${code}）`);
    });
    return publicTask(task);
  }

  function publishCompletedScan(task, result) {
    if (task.state !== "scanning") return;
    task.state = "publishing";
    task.progress = { ...task.progress, ...result, currentPath: task.drive.root };
    try {
      const manifest = {
        bytes: Number(result.bytes || 0),
        completedAt: result.completedAt,
        databaseFile: path.basename(result.outputPath),
        directories: Number(result.directories || 0),
        driveId: task.drive.id,
        errors: Number(result.errors || 0),
        files: Number(result.files || 0),
        linkedRoots: [...(task.drive.linkedRoots || [])],
        nodes: Number(result.nodes || 0),
        root: task.drive.root,
        scanId: task.scanId,
        schemaVersion: 1,
        skipped: Number(result.skipped || 0),
        startedAt: result.startedAt
      };
      writeManifest(task.drive, manifest);
      task.completedAt = manifest.completedAt;
      task.state = "complete";
      active = active === task ? null : active;
      setTimeout(() => cleanupDriveCaches(task.drive), 3000).unref?.();
    } catch (error) {
      failTask(task, error?.message || error);
    }
  }

  function failTask(task, error) {
    if (!["scanning", "publishing"].includes(task.state)) return;
    task.error = String(error || "磁盘扫描失败");
    task.completedAt = new Date().toISOString();
    task.state = "failed";
    active = active === task ? null : active;
    try {
      if (fs.statSync(task.outputPath, { throwIfNoEntry: false })?.isFile()) fs.rmSync(task.outputPath, { force: true });
    } catch (cleanupError) {
      warn("[disk-usage-cleanup]", cleanupError?.message || cleanupError);
    }
  }

  function driveSummary(drive) {
    const manifest = readManifest(drive);
    const task = active?.drive.id === drive.id ? active : lastTasks.get(drive.id);
    return {
      ...publicDrive(drive),
      cache: manifest ? publicManifest(manifest) : null,
      cacheNeedsRefresh: Boolean(manifest && !cacheCoversLinkedRoots(drive, manifest)),
      capacity: diskCapacity(drive.root),
      task: task ? publicTask(task) : null
    };
  }

  function requireDrive(driveId) {
    const id = String(driveId || "").trim().toLocaleUpperCase("en-US");
    const drive = drivesById.get(id);
    if (!drive) throw publicError("未知的监控磁盘", 404);
    return drive;
  }

  function normalizeTargetPath(drive, rawPath) {
    const value = String(rawPath || "").trim();
    if (!value) throw publicError("缺少路径", 400);
    const target = path.resolve(value);
    const relative = path.relative(drive.root, target);
    if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
      throw publicError("路径不在所选监控磁盘内", 403);
    }
    return target === path.resolve(drive.root) ? drive.root : target;
  }

  function readManifest(drive) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath(drive), "utf8"));
      const databaseFile = path.basename(String(manifest.databaseFile || ""));
      if (!databaseFile || !databaseFile.startsWith(`${drive.id.toLocaleLowerCase("en-US")}-`) || !databaseFile.endsWith(".sqlite")) return null;
      const databasePath = path.join(cacheDir, databaseFile);
      if (!fs.statSync(databasePath, { throwIfNoEntry: false })?.isFile()) return null;
      return { ...manifest, databaseFile, databasePath };
    } catch {
      return null;
    }
  }

  function writeManifest(drive, manifest) {
    fs.writeFileSync(manifestPath(drive), JSON.stringify(manifest, null, 2), "utf8");
  }

  function manifestPath(drive) {
    return path.join(cacheDir, `${drive.id.toLocaleLowerCase("en-US")}.json`);
  }

  function withCacheDatabase(drive, manifest, action) {
    const database = new DatabaseSync(manifest.databasePath, { readOnly: true });
    try {
      return action(database);
    } catch (error) {
      if (error?.statusCode) throw error;
      throw publicError(`无法读取 ${drive.name} 的磁盘缓存`, 500);
    } finally {
      database.close();
    }
  }

  function cleanupInterruptedCaches() {
    for (const drive of drives) cleanupDriveCaches(drive);
  }

  function cleanupDriveCaches(drive) {
    const current = readManifest(drive)?.databaseFile || "";
    let entries = [];
    try {
      entries = fs.readdirSync(cacheDir, { withFileTypes: true });
    } catch {
      return;
    }
    const prefix = `${drive.id.toLocaleLowerCase("en-US")}-`;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === current || !entry.name.startsWith(prefix) || !entry.name.endsWith(".sqlite")) continue;
      const target = path.join(cacheDir, entry.name);
      try {
        fs.rmSync(target, { force: true });
      } catch (error) {
        warn("[disk-usage-cleanup]", error?.message || error);
      }
    }
  }

  return {
    beginStop,
    cachedNode,
    refresh,
    search,
    start,
    status,
    stop,
    summary,
    tree
  };
}

function createDriveCatalog(sources) {
  const byRoot = new Map();
  for (const source of sources || []) {
    const sourcePath = String(source?.path || source || "").trim();
    const root = path.parse(sourcePath).root;
    if (!root || !/^[a-z]:[\\/]$/i.test(root)) continue;
    const key = root.toLocaleLowerCase("en-US");
    const record = byRoot.get(key) || {
      id: root.slice(0, 1).toLocaleUpperCase("en-US"),
      labels: new Set(),
      linkedRoots: new Set(),
      name: root.slice(0, 2).toLocaleUpperCase("en-US"),
      root
    };
    const label = String(source?.label || "").trim();
    if (label) record.labels.add(label);
    byRoot.set(key, record);

    const linkedRoot = linkedDirectoryRoot(sourcePath, root);
    if (linkedRoot) record.linkedRoots.add(linkedRoot);
  }
  return [...byRoot.values()]
    .map((drive) => ({ ...drive, labels: [...drive.labels], linkedRoots: [...drive.linkedRoots] }))
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
}

function publicDrive(drive) {
  return { id: drive.id, labels: drive.labels, monitoredLinks: [...(drive.linkedRoots || [])], name: drive.name, root: drive.root };
}

function linkedDirectoryRoot(sourcePath, driveRoot) {
  const resolved = path.resolve(sourcePath);
  if (!resolved || resolved.toLocaleLowerCase("en-US") === path.resolve(driveRoot).toLocaleLowerCase("en-US")) return "";
  try {
    const link = fs.lstatSync(resolved, { throwIfNoEntry: false });
    const target = fs.statSync(resolved, { throwIfNoEntry: false });
    return link?.isSymbolicLink() && target?.isDirectory() ? resolved : "";
  } catch {
    return "";
  }
}

function publicManifest(manifest) {
  return {
    bytes: Number(manifest.bytes || 0),
    completedAt: manifest.completedAt || "",
    directories: Number(manifest.directories || 0),
    errors: Number(manifest.errors || 0),
    files: Number(manifest.files || 0),
    linkedRoots: Array.isArray(manifest.linkedRoots) ? manifest.linkedRoots.map(String) : [],
    nodes: Number(manifest.nodes || 0),
    scanId: manifest.scanId || "",
    skipped: Number(manifest.skipped || 0),
    startedAt: manifest.startedAt || ""
  };
}

function cacheCoversLinkedRoots(drive, manifest) {
  const cached = new Set((manifest.linkedRoots || []).map((value) => path.resolve(String(value)).toLocaleLowerCase("en-US")));
  return (drive.linkedRoots || []).every((value) => cached.has(path.resolve(value).toLocaleLowerCase("en-US")));
}

function publicTask(task) {
  return {
    completedAt: task.completedAt || "",
    driveId: task.drive.id,
    driveName: task.drive.name,
    error: task.error || "",
    progress: { ...task.progress },
    scanId: task.scanId,
    startedAt: task.startedAt,
    state: task.state
  };
}

function publicNode(row) {
  return {
    depth: Number(row.depth || 0),
    directoryCount: Number(row.directory_count || 0),
    errorCount: Number(row.error_count || 0),
    extension: String(row.extension || ""),
    fileCount: Number(row.file_count || 0),
    isDirectory: Boolean(row.is_directory),
    modifiedMs: Number(row.modified_ms || 0),
    name: String(row.name || ""),
    parentPath: String(row.parent_path || ""),
    path: String(row.path || ""),
    size: Number(row.size_bytes || 0)
  };
}

function compareTreemapCandidates(left, right) {
  return Number(right.node.size || 0) - Number(left.node.size || 0) || left.level - right.level;
}

function insertTreemapCandidate(queue, candidate) {
  let low = 0;
  let high = queue.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareTreemapCandidates(candidate, queue[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  queue.splice(low, 0, candidate);
}

function diskCapacity(root) {
  try {
    const stat = fs.statfsSync(root, { bigint: true });
    const blockSize = stat.bsize || 0n;
    const total = Number(stat.blocks * blockSize);
    const free = Number(stat.bavail * blockSize);
    return { available: true, free, total, used: Math.max(0, total - free) };
  } catch {
    return { available: false, free: 0, total: 0, used: 0 };
  }
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function publicError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
