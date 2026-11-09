import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMangaService } from "../src/modules/photos/server/manga-service.js";

// Synthetic image headers in a private JSON library; no real media or database.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-dimensions-"));
const book = path.join(root, "smtt6_cache_dimensions");
fs.mkdirSync(book);
const real = { open: fs.promises.open, stat: fs.promises.stat, openSync: fs.openSync, statSync: fs.statSync };
const owned = new Set();
const files = new Set();
const handles = new Set();
let observed = null, shortReadLimit = Infinity, failRead = false, closeGate = null, failClose = false;
const cases = [
  ["png", image("png"), { width: 720, height: 1080 }, 4096],
  ["gif", image("gif"), { width: 720, height: 1080 }, 4096],
  ["webp", image("webp"), { width: 720, height: 1080 }, 4096],
  ["jpeg-front", image("jpeg", 20), { width: 720, height: 1080 }, 4096],
  ["jpeg-late", image("jpeg", 8200), { width: 720, height: 1080 }, 65536],
  ["jpeg-beyond-budget", image("jpeg", 70000), {}, 65536],
  ["unknown", Buffer.alloc(96000, 7), {}, 4096],
  ["tiny-png", image("png").subarray(0, 24), { width: 720, height: 1080 }, 24],
  ["short-png", image("png"), { width: 720, height: 1080 }, 4096],
  ["short-jpeg", image("jpeg", 8200), { width: 720, height: 1080 }, 65536],
  ["read-error", image("png"), {}, 0]
];
const stats = [];

try {
  const chapters = cases.map(([name, bytes], index) => {
    const local = `${name}.bin`, file = path.join(book, local);
    fs.writeFileSync(file, bytes); owned.add(file); files.add(file);
    return { index: index + 1, title: name, status: "done", images: [{ index: 1, local_path: local, status: "downloaded" }] };
  });
  const longChapter = cases.length + 1;
  chapters.push({ index: longChapter, title: "concurrent fixture", status: "done", images: cases.slice(0, 8).map(([name], index) => ({
    index: index + 1, local_path: `${name}.bin`, status: "downloaded"
  })) });
  for (const [name, data] of [["manifest.json", { chapters }], ["catalog.json", { title: "Dimensions", url: "https://synthetic.invalid/dimensions" }]]) {
    const file = path.join(book, name); fs.writeFileSync(file, JSON.stringify(data)); owned.add(file);
  }
  fs.openSync = (source, ...args) => {
    assert.equal(files.has(source), false, "chapter page opens must be asynchronous");
    return real.openSync(source, ...args);
  };
  fs.statSync = (source, ...args) => {
    assert.equal(files.has(source), false, "chapter page stats must be asynchronous");
    return real.statSync(source, ...args);
  };
  fs.promises.open = async (source, ...args) => {
    const handle = await real.open(source, ...args);
    if (!files.has(source)) return handle;
    const read = handle.read.bind(handle), close = handle.close.bind(handle);
    handles.add(handle);
    if (observed) observed.opens++;
    handle.read = async (buffer, offset, length, position) => {
      if (failRead) throw Object.assign(new Error("controlled image read failure"), { code: "EIO" });
      const result = await read(buffer, offset, Math.min(length, shortReadLimit), position);
      if (observed) { observed.calls++; observed.bytes += result.bytesRead; }
      return result;
    };
    handle.close = async () => {
      if (closeGate) await closeGate;
      await close();
      handles.delete(handle);
      if (observed) observed.closes++;
      if (failClose) throw Object.assign(new Error("controlled image close failure"), { code: "EIO" });
    };
    return handle;
  };
  const service = createMangaService({ root, safeStat(file) { try { return fs.statSync(file); } catch { return null; } } });
  for (let index = 0; index < cases.length; index++) {
    const [name, , dimensions, budget] = cases[index];
    shortReadLimit = name.startsWith("short-") ? 37 : Infinity;
    failRead = name === "read-error";
    observed = { name, bytes: 0, calls: 0, opens: 0, closes: 0 };
    const first = await service.publicChapter(book, index + 1);
    assert.equal(first.images.length, 1);
    assert.equal(first.images[0].width, dimensions.width, `${name} width`);
    assert.equal(first.images[0].height, dimensions.height, `${name} height`);
    assert.ok(observed.bytes <= budget, `${name}: expected at most ${budget} header bytes, read ${observed.bytes}`);
    assert.equal(observed.opens, observed.closes, `${name}: every opened descriptor must close`);
    stats.push({ ...observed });
    observed = { bytes: 0, calls: 0, opens: 0, closes: 0 };
    assert.deepEqual(await service.publicChapter(book, index + 1), first, `${name}: repeated response stays identical`);
    assert.equal(observed.opens, name === "read-error" ? 1 : 0,
      "only transient read errors should reopen an unchanged file");
  }
  failRead = false; shortReadLimit = Infinity;
  const changed = Buffer.concat([image("png"), Buffer.from([0])]);
  changed.writeUInt32BE(721, 16);
  await fs.promises.writeFile(path.join(book, "png.bin"), changed);
  observed = { bytes: 0, calls: 0, opens: 0, closes: 0 };
  const refreshed = await service.publicChapter(book, 1);
  assert.equal(refreshed.images[0].width, 721, "file signature changes must invalidate cached dimensions");
  assert.equal(observed.bytes, 4096);
  assert.equal((await service.publicChapter(book, cases.length)).images[0].width, 720, "a transient read failure is retryable");
  observed = null;
  await verifyReplacement();
  await verifyAdmissionAndStop(longChapter);
  await verifyUnconfirmedClose();
  assert.equal(handles.size, 0);
  console.log(JSON.stringify({ ok: true, stats, cacheInvalidation: true, chapterAdmissionAndPhysicalClose: true }));
} finally {
  fs.openSync = real.openSync; fs.statSync = real.statSync;
  fs.promises.open = real.open; fs.promises.stat = real.stat;
  closeGate = null; failClose = false;
  for (const handle of handles) { try { await handle.close(); } catch {} }
  for (const file of owned) { assert.equal(path.dirname(file), book); fs.unlinkSync(file); }
  fs.rmdirSync(book);
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  fs.rmdirSync(root);
}

async function verifyReplacement() {
  const source = path.join(book, "png.bin");
  const service = createMangaService({ root });
  let checks = 0;
  fs.promises.stat = async (target, ...args) => {
    if (target === source && ++checks === 2) {
      assert.equal(handles.size, 0, "rechecking a path must follow the actual handle close");
      const before = await real.stat(source);
      const replacement = Buffer.concat([image("png"), Buffer.from([0])]);
      replacement.writeUInt32BE(722, 16);
      const sibling = path.join(book, "replacement.bin");
      fs.writeFileSync(sibling, replacement);
      owned.add(sibling);
      fs.utimesSync(sibling, before.atime, before.mtime);
      fs.renameSync(sibling, source);
      owned.delete(sibling);
    }
    return real.stat(target, ...args);
  };
  try {
    assert.equal((await service.publicChapter(book, 1)).images[0].width, undefined, "replacement cannot publish the old handle's dimensions");
    assert.equal((await service.publicChapter(book, 1)).images[0].width, 722, "same-sized replacement is readable on retry");
  } finally {
    fs.promises.stat = real.stat;
    await service.stopChapterReads();
  }
}

async function verifyAdmissionAndStop(index) {
  const service = createMangaService({ root });
  const controllers = Array.from({ length: 16 }, () => new AbortController());
  let release, stopped = false;
  closeGate = new Promise(resolve => { release = resolve; });
  const tasks = controllers.map(({ signal }) => service.publicChapter(book, index, undefined, {}, { signal }).catch(error => error.code));
  try {
    await assert.rejects(service.publicChapter(book, index), { code: "MANGA_DIMENSIONS_BUSY", statusCode: 503 });
    for (let i = 0; handles.size < 4 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(handles.size, 4, "two chapters may open no more than two pages each");
    controllers.forEach(controller => controller.abort());
    assert.deepEqual(await Promise.all(tasks), Array(16).fill("MANGA_DIMENSIONS_STOPPED"));
    const stopping = service.stopChapterReads().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(handles.size, 4, "disconnected operations still own held physical closes");
    release();
    await stopping;
    assert.equal(handles.size, 0);
    closeGate = null;
    await service.startChapterReads();
    const resumed = await service.publicChapter(book, index);
    assert.deepEqual(resumed.images.map(page => page.index), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(resumed.images.map(page => page.width), [722, 720, 720, 720, 720, undefined, undefined, 720]);
  } finally {
    release(); closeGate = null;
    await service.stopChapterReads();
  }
}

async function verifyUnconfirmedClose() {
  const service = createMangaService({ root });
  failClose = true;
  try {
    await assert.rejects(service.publicChapter(book, 1), { code: "MANGA_DIMENSIONS_STOPPED", statusCode: 503 });
    await assert.rejects(service.stopChapterReads(), { code: "MANGA_DIMENSIONS_CLOSE_INCOMPLETE" });
    await assert.rejects(service.startChapterReads(), { code: "MANGA_DIMENSIONS_CLOSE_INCOMPLETE" });
  } finally { failClose = false; }
}

function image(format, marker = 20) {
  const buffer = Buffer.alloc(96000);
  if (format === "png") {
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
    buffer.writeUInt32BE(720, 16); buffer.writeUInt32BE(1080, 20);
  } else if (format === "gif") {
    buffer.write("GIF89a"); buffer.writeUInt16LE(720, 6); buffer.writeUInt16LE(1080, 8);
  } else if (format === "webp") {
    buffer.write("RIFF"); buffer.write("WEBP", 8); buffer.write("VP8X", 12);
    buffer.writeUIntLE(719, 24, 3); buffer.writeUIntLE(1079, 27, 3);
  } else {
    buffer[0] = 0xff; buffer[1] = 0xd8;
    // Multiple legal application segments can place SOF beyond the read cap.
    let offset = 2;
    while (marker - offset > 65537) {
      buffer[offset] = 0xff; buffer[offset + 1] = 0xe0;
      buffer.writeUInt16BE(65535, offset + 2); offset += 65537;
    }
    buffer[offset] = 0xff; buffer[offset + 1] = 0xe0;
    buffer.writeUInt16BE(marker - offset - 2, offset + 2);
    buffer[marker] = 0xff; buffer[marker + 1] = 0xc0;
    buffer.writeUInt16BE(17, marker + 2); buffer[marker + 4] = 8;
    buffer.writeUInt16BE(1080, marker + 5); buffer.writeUInt16BE(720, marker + 7);
  }
  return buffer;
}
