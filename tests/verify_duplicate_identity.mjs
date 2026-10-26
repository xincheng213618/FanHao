import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Only the production service source is read from disk. Every database stamp,
// file stat, realpath, open and content read below belongs to this virtual FS.
const serviceUrl = new URL("../src/modules/fanhao/server/duplicates/service.js", import.meta.url);
let source = await fs.readFile(serviceUrl, "utf8");
const binding = "__fanHaoDuplicateIdentityFixture";
assert.equal(Object.hasOwn(globalThis, binding), false);
const bridge = { current: null };
const methods = ["stat", "lstat", "realpath", "open"];
bridge.fs = Object.fromEntries(methods.map(method => [method, (...args) => bridge.current[method](...args)]));
bridge.guard = (filePath, roots) => {
  assert(bridge.current.links.has(filePath), "service must authorize a known virtual video");
  assert(roots.some(root => {
    const relative = path.win32.relative(root, filePath);
    return !relative.startsWith("..") && !path.win32.isAbsolute(relative);
  }), "virtual video must remain in its declared root");
};
function replaceImport(before, after) {
  assert.equal(source.split(before).length, 2, `expected one production dependency: ${before}`);
  source = source.replace(before, after);
}
replaceImport('import fs from "node:fs/promises";', `const fs = globalThis.${binding}.fs;`);
const guardImport = 'import { ensureRealPathWithinRoots } from ' + JSON.stringify("../../../../platform/server/library-path-safety.js") + ';';
replaceImport(guardImport, `const ensureRealPathWithinRoots = globalThis.${binding}.guard;`);
replaceImport('import { checkDuplicateAvailability } from ' + JSON.stringify("./availability.js") + ';',
  'const checkDuplicateAvailability = () => { throw new Error("Virtual hash checks must not inspect real filesystem availability"); };');
globalThis[binding] = bridge;

const stamp = "2026-10-24T00:00:00.000Z";
const nanoseconds = BigInt(Date.parse(stamp)) * 1_000_000n;
const dbPath = "C:\\duplicate-identity-fixture\\index.sqlite";
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const groupId = "a".repeat(64);
let checks = 0;
const equal = (...args) => { assert.equal(...args); checks++; };
const deepEqual = (...args) => { assert.deepEqual(...args); checks++; };

function virtualFs() {
  const links = new Map(), opened = [], closed = [], readBytes = new Map();
  const node = (canonical, bytes, ino = 42n) => ({ canonical, bytes, dev: 0n, ino, mtimeNs: nanoseconds, ctimeNs: nanoseconds });
  const lookup = filePath => {
    assert(links.has(filePath), `unexpected virtual path: ${filePath}`);
    return links.get(filePath);
  };
  const stat = entry => ({ dev: entry.dev, ino: entry.ino, size: BigInt(entry.bytes.length), mtimeNs: entry.mtimeNs,
    ctimeNs: entry.ctimeNs, isFile: () => true, isSymbolicLink: () => false });
  const vfs = {
    links, node, opened, closed, readBytes, onRead: null,
    async stat(filePath) {
      assert([dbPath, `${dbPath}-wal`].includes(filePath), "snapshot may stat only virtual database files");
      return { size: 1, mtimeMs: 1 };
    },
    async lstat(filePath) { return stat(lookup(filePath)); },
    async realpath(filePath) { return lookup(filePath).canonical; },
    async open(filePath, mode) {
      assert.equal(mode, "r", "duplicate comparison is read-only");
      const entry = lookup(filePath); opened.push(filePath);
      let isClosed = false;
      return {
        async stat() { assert.equal(isClosed, false); return stat(entry); },
        async read(buffer, offset, length, position) {
          assert.equal(isClosed, false);
          vfs.onRead?.({ filePath, entry, position });
          const bytesRead = entry.bytes.copy(buffer, offset, position, position + length);
          readBytes.set(filePath, (readBytes.get(filePath) || 0) + bytesRead);
          return { bytesRead };
        },
        async close() { assert.equal(isClosed, false); isClosed = true; closed.push(filePath); }
      };
    }
  };
  return vfs;
}

function row(id, filePath, bytes) {
  return { id: String(id), workId: String(id), name: "TEST-100.mp4", path: filePath, size: bytes.length, modifiedAt: stamp };
}

async function run(createDuplicateService, vfs, rows) {
  bridge.current = vfs;
  const group = { id: groupId, files: rows };
  const service = createDuplicateService({
    dbPath, roots: [...new Set(rows.map(file => path.win32.dirname(file.path)))],
    snapshotLoader: async () => ({ summary: {}, groups: [group] }),
    resolveWork: id => ({ videos: rows.filter(file => file.workId === id) }),
    resolveVideo: id => rows.find(file => file.id === id),
    workerFactory: () => { throw new Error("identity fixture must not create a worker"); },
    videoProbeService: { probeCachedAsync: () => { throw new Error("identity fixture must not probe media"); } }
  });
  try {
    const { job } = await service.startCheck(groupId);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const current = service.check(job.id).job;
      if (current.status !== "running") return current;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error("virtual duplicate comparison did not finish");
  } finally { await service.stop(); }
}

try {
  const { createDuplicateService } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const original = Buffer.alloc(2 * 1024 * 1024 + 17, 65);
  const different = Buffer.from(original); different[different.length - 1] = 66;

  // Equal SMB stat identities are not evidence that different shares contain
  // one physical file. The only differing content byte is at the very end.
  {
    const vfs = virtualFs();
    const rows = [row(1, "\\\\nas-one\\media\\TEST-100.mp4", original), row(2, "\\\\nas-two\\media\\TEST-100.mp4", different)];
    vfs.links.set(rows[0].path, vfs.node(rows[0].path, original));
    vfs.links.set(rows[1].path, vfs.node(rows[1].path, different));
    const job = await run(createDuplicateService, vfs, rows);
    equal(job.status, "complete");
    deepEqual(vfs.opened, rows.map(file => file.path));
    deepEqual(vfs.closed, vfs.opened);
    deepEqual(rows.map(file => vfs.readBytes.get(file.path)), [original.length, different.length]);
    deepEqual(job.files.map(file => file.status), ["hashed", "hashed"]);
    deepEqual(job.files.map(file => file.sha256), [hash(original), hash(different)]);
    deepEqual(job.matches, []);
    equal(job.progressBytes, original.length + different.length);
  }

  // B initially resolves to A. While C is being read, B switches to another
  // target. Even identical SMB stat values cannot hide the changed realpath.
  for (const preserveStat of [false, true]) {
    const vfs = virtualFs();
    const rows = [row(1, "C:\\media\\TEST-100.mp4", original), row(2, "C:\\alias\\TEST-100.mp4", original), row(3, "C:\\other\\TEST-100.mp4", original)];
    const primary = vfs.node(rows[0].path, original);
    const replacement = vfs.node("C:\\replacement\\TEST-100.mp4", different, preserveStat ? primary.ino : 99n);
    if (!preserveStat) { replacement.mtimeNs += 2_000_000n; replacement.ctimeNs += 2_000_000n; }
    vfs.links.set(rows[0].path, primary); vfs.links.set(rows[1].path, primary);
    vfs.links.set(rows[2].path, vfs.node(rows[2].path, original, 43n));
    let replaced = false;
    vfs.onRead = ({ filePath }) => {
      if (filePath === rows[2].path && !replaced) { replaced = true; vfs.links.set(rows[1].path, replacement); }
    };
    const job = await run(createDuplicateService, vfs, rows);
    equal(replaced, true);
    equal(job.status, "complete");
    equal(job.files.find(file => file.id === "2").status, "changed");
    equal(job.files.some(file => file.status === "same_file"), false);
    deepEqual(job.matches.map(match => match.fileIds), [["1", "3"]]);
    deepEqual(vfs.opened, [rows[0].path, rows[2].path]);
    deepEqual(vfs.closed, vfs.opened);
  }

  // A stable canonical alias is still valid, with a single reference direction
  // rather than the old A->B->A cycle. It requires no duplicate physical read.
  {
    const vfs = virtualFs();
    const rows = [row(1, "C:\\media\\TEST-100.mp4", original), row(2, "C:\\alias\\TEST-100.mp4", original)];
    const primary = vfs.node(rows[0].path, original);
    for (const file of rows) vfs.links.set(file.path, primary);
    const job = await run(createDuplicateService, vfs, rows);
    equal(job.status, "complete");
    deepEqual(job.files.map(file => file.status), ["same_file", "same_file"]);
    equal(job.files[0].sameAs, undefined);
    equal(job.files[1].sameAs, "1");
    deepEqual(vfs.opened, []);
  }
  console.log(`Duplicate identity verified: ${checks} checks (virtual SMB inode collisions, complete content reads, changing aliases and stable references; no real media I/O).`);
} finally { delete globalThis[binding]; }
