import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { streamStoredZip } from "../src/modules/photos/server/stored-zip-stream.js";

// Synthetic streams exercise cancellation and failures. The physical-close
// case reads this fixture itself; no media, database, temporary files or
// production server are touched.
const virtualPath = path.resolve("__stored_zip_virtual_fixture__");
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
class Sink extends Writable {
  constructor({ blockWrite = 0 } = {}) {
    super({ highWaterMark: 1 });
    this.chunks = []; this.blockWrite = blockWrite; this.blocked = deferred(); this.endCalls = 0;
    this.on("error", () => {});
  }
  _write(chunk, _encoding, done) {
    this.chunks.push(Buffer.from(chunk));
    if (this.chunks.length === this.blockWrite) { this.pendingWrite = done; this.blocked.resolve(); }
    else done();
  }
  end(...args) { this.endCalls++; return super.end(...args); }
  get body() { return Buffer.concat(this.chunks); }
}
async function synthetic(run, { read, stat } = {}) {
  const originalStat = fs.statSync, originalRead = fs.createReadStream;
  const sources = [];
  let statCalls = 0;
  fs.statSync = (filename, ...args) => {
    if (filename !== virtualPath) return originalStat(filename, ...args);
    statCalls++;
    return stat ? stat() : { isFile: () => true, size: 7, mtime: new Date(2026, 0, 1) };
  };
  fs.createReadStream = (filename, ...args) => {
    if (filename !== virtualPath) return originalRead(filename, ...args);
    const source = read ? read() : Readable.from([Buffer.from("payload")]);
    sources.push(source); return source;
  };
  try { await run({ sources, statCalls: () => statCalls, files: [{ path: virtualPath, name: "章节/0001.bin" }] }); }
  finally {
    for (const source of sources) source.destroy();
    fs.statSync = originalStat; fs.createReadStream = originalRead;
  }
}

const cases = [];
const add = (name, run) => cases.push({ name, run });
add("successful-archive-preserves-payload-names-and-order", () => synthetic(async f => {
  const sink = new Sink();
  assert.equal(await streamStoredZip(sink, [...f.files, { path: virtualPath, name: "second.bin" }]), true);
  const bytes = sink.body;
  let offset = 0;
  for (const name of ["章节/0001.bin", "second.bin"]) {
    assert.equal(bytes.readUInt32LE(offset), 0x04034b50);
    const nameLength = bytes.readUInt16LE(offset + 26);
    assert.equal(bytes.subarray(offset + 30, offset + 30 + nameLength).toString(), name);
    offset += 30 + nameLength;
    assert.equal(bytes.subarray(offset, offset + 7).toString(), "payload"); offset += 7;
    assert.equal(bytes.readUInt32LE(offset), 0x08074b50);
    assert.equal(bytes.readUInt32LE(offset + 4), 0x422c6a15);
    assert.equal(bytes.readUInt32LE(offset + 8), 7); offset += 16;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length - 22), 0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length - 14), 2);
  assert.equal(sink.endCalls, 1); assert(f.sources.every(source => source.closed));
}));

add("zip64-preserves-a-large-entry-and-the-next-entry-offset", async () => {
  const block = Buffer.alloc(4 * 1024 * 1024);
  const largeSize = 0x100000000 + 7;
  let opened = 0, discovered = 0;
  await synthetic(async f => {
    const records = new Map();
    let offset = 0;
    const sink = new Writable({ write(chunk, _encoding, done) {
      if (chunk.length < block.length) records.set(offset, Buffer.from(chunk));
      offset += chunk.length;
      done();
    } });
    assert.equal(await streamStoredZip(sink, [...f.files, { path: virtualPath, name: "next.bin" }]), true);
    const local = records.get(0), extra = records.get(30 + local.readUInt16LE(26));
    assert.equal(local.readUInt16LE(4), 45);
    assert.equal(local.readUInt32LE(18), 0xffffffff);
    assert.equal(local.readUInt32LE(22), 0xffffffff);
    assert.equal(local.readUInt16LE(28), 20);
    assert.equal(extra.readUInt16LE(0), 1);
    assert.equal(extra.readUInt16LE(2), 16);
    const descriptorOffset = 30 + local.readUInt16LE(26) + extra.length + largeSize;
    const descriptor = records.get(descriptorOffset);
    assert.equal(descriptor.readUInt32LE(0), 0x08074b50);
    assert.equal(descriptor.readBigUInt64LE(8), BigInt(largeSize));
    assert.equal(descriptor.readBigUInt64LE(16), BigInt(largeSize));
    const nextOffset = descriptorOffset + descriptor.length;
    assert.equal(records.get(nextOffset).readUInt32LE(0), 0x04034b50);
    assert.equal(records.get(nextOffset + 30 + Buffer.byteLength("next.bin")).toString(), "payload");

    const footerOffset = offset - 22 - 20 - 56;
    const footer = records.get(footerOffset);
    assert.equal(footer.readUInt32LE(0), 0x06064b50);
    assert.equal(footer.readBigUInt64LE(32), 2n);
    const centralOffset = Number(footer.readBigUInt64LE(48));
    assert(centralOffset > 0xffffffff);
    assert.equal(footer.readBigUInt64LE(40), BigInt(footerOffset - centralOffset));
    const central = records.get(centralOffset);
    const centralExtra = records.get(centralOffset + 46 + central.readUInt16LE(28));
    assert.equal(central.readUInt32LE(20), 0xffffffff);
    assert.equal(central.readUInt32LE(16), descriptor.readUInt32LE(4));
    assert.equal(centralExtra.readBigUInt64LE(4), BigInt(largeSize));
    assert.equal(centralExtra.readBigUInt64LE(12), BigInt(largeSize));
    const nextCentralOffset = centralOffset + 46 + central.readUInt16LE(28) + centralExtra.length;
    const nextCentral = records.get(nextCentralOffset);
    const nextExtra = records.get(nextCentralOffset + 46 + Buffer.byteLength("next.bin"));
    assert.equal(nextCentral.readUInt32LE(24), 7);
    assert.equal(nextCentral.readUInt32LE(42), 0xffffffff);
    assert.equal(nextExtra.readUInt16LE(2), 8);
    assert.equal(nextExtra.readBigUInt64LE(4), BigInt(nextOffset));
    assert.equal(records.get(footerOffset + 56).readBigUInt64LE(8), BigInt(footerOffset));
    assert.equal(records.get(offset - 22).readUInt32LE(16), 0xffffffff);
    assert.equal(opened, 2);
  }, {
    stat: () => ({ isFile: () => true, size: discovered++ === 0 ? largeSize : 7, mtime: new Date(2026, 0, 1) }),
    read: () => {
      opened++;
      return Readable.from(discovered === 1 ? (function* () {
        for (let index = 0; index < 1024; index++) yield block;
        yield Buffer.alloc(7);
      })() : [Buffer.from("payload")]);
    }
  });
});

add("zip64-count-keeps-every-entry-beyond-the-classic-directory-limit", () => synthetic(async f => {
  const files = Array.from({ length: 65536 }, (_, index) => ({ ...f.files[0], name: `page-${index}.jpg` }));
  let headers = 0, tail = [];
  const sink = new Writable({ write(chunk, _encoding, done) {
    if (chunk.length === 46 && chunk.readUInt32LE(0) === 0x02014b50) headers++;
    tail.push(Buffer.from(chunk));
    if (tail.length > 3) tail.shift();
    done();
  } });
  assert.equal(await streamStoredZip(sink, files), true);
  assert.equal(headers, files.length);
  const [footer, locator, end] = tail;
  assert.equal(footer.readUInt32LE(0), 0x06064b50);
  assert.equal(footer.readBigUInt64LE(24), BigInt(files.length));
  assert.equal(footer.readBigUInt64LE(32), BigInt(files.length));
  assert.equal(locator.readUInt32LE(0), 0x07064b50);
  assert.equal(end.readUInt16LE(10), 0xffff);
}, { stat: () => ({ isFile: () => true, size: 0, mtime: new Date(2026, 0, 1) }), read: () => Readable.from([]) }));

add("already-closed-response-never-stats-or-opens", () => synthetic(async f => {
  for (const mode of ["destroy", "end"]) {
    const sink = new Sink(); sink[mode]();
    assert.equal(await streamStoredZip(sink, f.files), false);
  }
  assert.equal(f.statCalls(), 0); assert.equal(f.sources.length, 0);
}));

add("disconnect-during-read-destroys-source-and-awaits-close", async () => {
  const reading = deferred(), closing = deferred(), release = deferred();
  await synthetic(async f => {
    const sink = new Sink(); let settled = false;
    const pending = streamStoredZip(sink, f.files); pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await reading.promise; sink.destroy(); await tick();
      assert.equal(f.sources[0].destroyed, true, "disconnect must interrupt an idle read");
      await closing.promise; assert.equal(settled, false, "destroy is not physical close");
      release.resolve(); assert.equal(await pending, false); assert.equal(f.sources[0].closed, true);
      assert.equal(sink.endCalls, 0); assert.equal(sink.listenerCount("close"), 0);
    } finally { release.resolve(); f.sources[0]?.destroy(); await pending.catch(() => {}); }
  }, { read: () => new Readable({ read() { reading.resolve(); }, destroy(error, done) { closing.resolve(); release.promise.then(() => done(error)); } }) });
});

add("backpressure-pauses-body-and-cancellation-closes-source", () => synthetic(async f => {
  const sink = new Sink({ blockWrite: 3 }); const pending = streamStoredZip(sink, f.files);
  await sink.blocked.promise; await tick();
  assert.equal(sink.chunks.length, 3, "no descriptor or directory may bypass backpressure");
  sink.destroy(); assert.equal(await pending, false); assert.equal(sink.endCalls, 0);
  assert(f.sources.every(source => source.closed));
  assert.equal(sink.listenerCount("drain"), 0); assert.equal(sink.listenerCount("close"), 0);
}));

add("backpressure-drain-resumes-the-same-archive", () => synthetic(async f => {
  const sink = new Sink({ blockWrite: 3 }); const pending = streamStoredZip(sink, f.files);
  await sink.blocked.promise; sink.pendingWrite();
  assert.equal(await pending, true); assert.equal(sink.endCalls, 1);
  assert.equal(sink.body.readUInt32LE(sink.body.length - 22), 0x06054b50);
}));

add("disconnect-during-header-backpressure-never-opens-source", () => synthetic(async f => {
  const sink = new Sink({ blockWrite: 1 }); const pending = streamStoredZip(sink, f.files);
  await sink.blocked.promise; sink.destroy();
  assert.equal(await pending, false); assert.equal(f.sources.length, 0); assert.equal(sink.endCalls, 0);
  assert.equal(sink.listenerCount("drain"), 0);
}));

add("source-error-destroys-truncated-response", () => synthetic(async f => {
  const sink = new Sink();
  await assert.rejects(streamStoredZip(sink, f.files), /controlled read failure/);
  assert.equal(sink.destroyed, true); assert.equal(sink.endCalls, 0);
  assert(f.sources.every(source => source.closed));
}, { read: () => new Readable({ read() { this.destroy(new Error("controlled read failure")); } }) }));

add("source-error-during-drain-cannot-hang", () => synthetic(async f => {
  const sink = new Sink({ blockWrite: 3 }); const pending = streamStoredZip(sink, f.files);
  const failed = assert.rejects(pending, /controlled blocked read failure/);
  await sink.blocked.promise; f.sources[0].destroy(new Error("controlled blocked read failure"));
  await failed; assert.equal(sink.destroyed, true); assert.equal(sink.endCalls, 0);
  assert.equal(sink.listenerCount("drain"), 0); assert(f.sources.every(source => source.closed));
}, { read: () => { let pushed = false; return new Readable({ read() { if (!pushed) { pushed = true; this.push(Buffer.from("payload")); } } }); } }));

add("response-error-during-read-closes-the-source", async () => {
  const reading = deferred();
  await synthetic(async f => {
    const sink = new Sink(); const pending = streamStoredZip(sink, f.files);
    const failed = assert.rejects(pending, /controlled response failure/);
    await reading.promise; sink.destroy(new Error("controlled response failure"));
    await failed; assert.equal(f.sources[0].closed, true); assert.equal(sink.endCalls, 0);
  }, { read: () => new Readable({ read() { reading.resolve(); } }) });
});

add("stat-error-destroys-response-without-opening", () => synthetic(async f => {
  const sink = new Sink();
  await assert.rejects(streamStoredZip(sink, f.files), /controlled metadata failure/);
  assert.equal(sink.destroyed, true); assert.equal(sink.endCalls, 0); assert.equal(f.sources.length, 0);
}, { stat: () => { throw new Error("controlled metadata failure"); } }));

add("changed-source-size-does-not-finish-a-partial-archive", async () => {
  for (const payload of ["short", "longer than expected"]) {
    await synthetic(async f => {
      const sink = new Sink();
      await assert.rejects(streamStoredZip(sink, f.files), { code: "ZIP_SOURCE_CHANGED" });
      assert.equal(sink.destroyed, true); assert.equal(sink.endCalls, 0);
      assert.equal(sink.body.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), false);
      assert(f.sources.every(source => source.closed));
    }, { read: () => Readable.from([Buffer.from(payload)]) });
  }
});

add("actual-file-cancellation-waits-for-native-close", async () => {
  const filename = fileURLToPath(import.meta.url), originalRead = fs.createReadStream, originalClose = fs.close;
  let physicalFd, source, finishClose, pending;
  const closing = deferred();
  fs.createReadStream = (target, ...args) => {
    const stream = originalRead(target, ...args);
    if (target === filename) { source = stream; stream.once("open", fd => { physicalFd = fd; }); }
    return stream;
  };
  fs.close = (fd, callback) => {
    if (fd !== physicalFd) return originalClose(fd, callback);
    finishClose = () => originalClose(fd, callback); closing.resolve();
  };
  try {
    const sink = new Sink({ blockWrite: 3 }); let settled = false;
    pending = streamStoredZip(sink, [{ path: filename, name: "fixture.mjs" }]);
    pending.then(() => { settled = true; }, () => { settled = true; });
    await sink.blocked.promise; sink.destroy(); await closing.promise; await tick();
    assert.equal(settled, false); assert.equal(fs.fstatSync(physicalFd).isFile(), true);
    finishClose(); finishClose = null;
    assert.equal(await pending, false); assert.equal(source.closed, true);
    assert.throws(() => fs.fstatSync(physicalFd), { code: "EBADF" });
  } finally {
    finishClose?.(); source?.destroy(); if (pending) await pending.catch(() => {});
    fs.createReadStream = originalRead; fs.close = originalClose;
  }
});

add("validated-file-cancellation-waits-for-handle-close", async () => {
  const filename = fs.realpathSync.native(fileURLToPath(import.meta.url)), open = fs.promises.open;
  const closing = deferred(), releaseClose = deferred();
  let physicalFd, pending;
  fs.promises.open = async (target, ...args) => {
    const handle = await open(target, ...args);
    if (target === filename) {
      physicalFd = handle.fd;
      const close = handle.close.bind(handle);
      handle.close = async () => { closing.resolve(); await releaseClose.promise; await close(); };
    }
    return handle;
  };
  try {
    const sink = new Sink({ blockWrite: 3 });
    let settled = false;
    const expectedStat = fs.statSync(filename);
    pending = streamStoredZip(sink, [{ path: filename, name: "fixture.mjs", expectedStat }]);
    pending.then(() => { settled = true; }, () => { settled = true; });
    await sink.blocked.promise; sink.destroy(); await closing.promise; await tick();
    assert.equal(settled, false);
    assert.equal(fs.fstatSync(physicalFd).isFile(), true);
    releaseClose.resolve();
    assert.equal(await pending, false);
    assert.throws(() => fs.fstatSync(physicalFd), { code: "EBADF" });
  } finally {
    releaseClose.resolve(); if (pending) await pending.catch(() => {});
    fs.promises.open = open;
  }
});

const selectedName = process.argv.find(arg => arg.startsWith("--case="))?.slice(7);
const selected = cases.filter(test => !selectedName || test.name === selectedName);
assert(selected.length, `unknown case: ${selectedName}`);
for (const test of selected) {
  const watchdog = setTimeout(() => { console.error(`stored-zip-stream: TIMEOUT ${test.name}`); process.exit(1); }, 5000);
  try { await test.run(); console.log(`stored-zip-stream: PASS ${test.name}`); }
  finally { clearTimeout(watchdog); }
}
console.log(`stored-zip-stream: ${selected.length} cases PASS`);
