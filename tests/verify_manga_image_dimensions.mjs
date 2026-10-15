import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMangaService } from "../src/modules/photos/server/manga-service.js";

// Synthetic image headers in a private JSON library; no real media or database.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-dimensions-"));
const book = path.join(root, "smtt6_cache_dimensions");
fs.mkdirSync(book);
const real = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
const owned = new Set();
const files = new Set();
const handles = new Map();
let observed = null, shortReadLimit = Infinity, failRead = false;
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
  for (const [name, data] of [["manifest.json", { chapters }], ["catalog.json", { title: "Dimensions", url: "https://synthetic.invalid/dimensions" }]]) {
    const file = path.join(book, name); fs.writeFileSync(file, JSON.stringify(data)); owned.add(file);
  }
  fs.openSync = (...args) => {
    const descriptor = real.open(...args);
    if (files.has(args[0])) { handles.set(descriptor, args[0]); if (observed) observed.opens++; }
    return descriptor;
  };
  fs.readSync = (descriptor, buffer, offset, length, position) => {
    if (!handles.has(descriptor)) return real.read(descriptor, buffer, offset, length, position);
    if (failRead) throw Object.assign(new Error("controlled image read failure"), { code: "EIO" });
    const count = real.read(descriptor, buffer, offset, Math.min(length, shortReadLimit), position);
    if (observed) { observed.calls++; observed.bytes += count; }
    return count;
  };
  fs.closeSync = descriptor => {
    const result = real.close(descriptor);
    if (handles.delete(descriptor) && observed) observed.closes++;
    return result;
  };
  const service = createMangaService({ root, safeStat(file) { try { return fs.statSync(file); } catch { return null; } } });
  for (let index = 0; index < cases.length; index++) {
    const [name, , dimensions, budget] = cases[index];
    shortReadLimit = name.startsWith("short-") ? 37 : Infinity;
    failRead = name === "read-error";
    observed = { name, bytes: 0, calls: 0, opens: 0, closes: 0 };
    const first = service.publicChapter(book, index + 1);
    assert.equal(first.images.length, 1);
    assert.equal(first.images[0].width, dimensions.width, `${name} width`);
    assert.equal(first.images[0].height, dimensions.height, `${name} height`);
    assert.ok(observed.bytes <= budget, `${name}: expected at most ${budget} header bytes, read ${observed.bytes}`);
    assert.equal(observed.opens, observed.closes, `${name}: every opened descriptor must close`);
    stats.push({ ...observed });
    observed = { bytes: 0, calls: 0, opens: 0, closes: 0 };
    assert.deepEqual(service.publicChapter(book, index + 1), first, `${name}: cached response stays identical`);
    assert.equal(observed.opens, 0, "unchanged files must reuse cached dimensions, including unsupported formats");
  }
  failRead = false; shortReadLimit = Infinity;
  const changed = Buffer.concat([image("png"), Buffer.from([0])]);
  changed.writeUInt32BE(721, 16);
  fs.writeFileSync(path.join(book, "png.bin"), changed);
  observed = { bytes: 0, calls: 0, opens: 0, closes: 0 };
  const refreshed = service.publicChapter(book, 1);
  assert.equal(refreshed.images[0].width, 721, "file signature changes must invalidate cached dimensions");
  assert.equal(observed.bytes, 4096);
  assert.equal(handles.size, 0);
  console.log(JSON.stringify({ ok: true, stats, cacheInvalidation: true }));
} finally {
  fs.openSync = real.open; fs.readSync = real.read; fs.closeSync = real.close;
  for (const descriptor of handles.keys()) { try { real.close(descriptor); } catch {} }
  for (const file of owned) { assert.equal(path.dirname(file), book); fs.unlinkSync(file); }
  fs.rmdirSync(book);
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  fs.rmdirSync(root);
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
