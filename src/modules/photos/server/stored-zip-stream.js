import fs from "node:fs";
import { crc32 } from "node:zlib";

const ZIP32_SIZE_LIMIT = 0xffffffff;
const ZIP32_COUNT_LIMIT = 0xffff;
const ZIP64_VERSION = 45;

function dosDateTime(value = new Date()) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function writeBuffer(res, buffer) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (res.write(buffer)) return Promise.resolve(true);
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (writable) => {
      res.off("drain", drained);
      res.off("close", stopped);
      res.off("error", stopped);
      resolve(writable && !res.destroyed && !res.writableEnded);
    };
    const drained = () => done(true), stopped = () => done(false);
    res.once("drain", drained);
    res.once("close", stopped);
    res.once("error", stopped);
  });
}

function zip64Extra(...values) {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(extra.length - 4, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return extra;
}

function localHeader(name, date, time, extra) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(extra ? ZIP64_VERSION : 20, 4);
  header.writeUInt16LE(0x0808, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  if (extra) {
    header.writeUInt32LE(ZIP32_SIZE_LIMIT, 18);
    header.writeUInt32LE(ZIP32_SIZE_LIMIT, 22);
    header.writeUInt16LE(extra.length, 28);
  }
  header.writeUInt16LE(name.length, 26);
  return header;
}

function dataDescriptor(crc, size, largeSize) {
  const descriptor = Buffer.alloc(largeSize ? 24 : 16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  if (largeSize) {
    descriptor.writeBigUInt64LE(BigInt(size), 8);
    descriptor.writeBigUInt64LE(BigInt(size), 16);
  } else {
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
  }
  return descriptor;
}

function centralHeader(entry) {
  const largeOffset = entry.offset >= ZIP32_SIZE_LIMIT;
  const values = [];
  if (entry.largeSize) values.push(entry.size, entry.size);
  if (largeOffset) values.push(entry.offset);
  const extra = values.length ? zip64Extra(...values) : null;
  const version = extra ? ZIP64_VERSION : 20;
  const size = entry.largeSize ? ZIP32_SIZE_LIMIT : entry.size;
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(version, 4);
  header.writeUInt16LE(version, 6);
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(extra?.length ?? 0, 30);
  header.writeUInt32LE(largeOffset ? ZIP32_SIZE_LIMIT : Number(entry.offset), 42);
  return { header, extra };
}

function endRecords(count, centralOffset, archiveOffset) {
  const centralSize = archiveOffset - centralOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, ZIP32_COUNT_LIMIT), 8);
  end.writeUInt16LE(Math.min(count, ZIP32_COUNT_LIMIT), 10);
  end.writeUInt32LE(centralSize >= ZIP32_SIZE_LIMIT ? ZIP32_SIZE_LIMIT : Number(centralSize), 12);
  end.writeUInt32LE(centralOffset >= ZIP32_SIZE_LIMIT ? ZIP32_SIZE_LIMIT : Number(centralOffset), 16);
  if (count < ZIP32_COUNT_LIMIT && centralSize < ZIP32_SIZE_LIMIT && centralOffset < ZIP32_SIZE_LIMIT) return [end];

  const zip64End = Buffer.alloc(56);
  zip64End.writeUInt32LE(0x06064b50, 0);
  zip64End.writeBigUInt64LE(44n, 4);
  zip64End.writeUInt16LE(ZIP64_VERSION, 12);
  zip64End.writeUInt16LE(ZIP64_VERSION, 14);
  zip64End.writeBigUInt64LE(BigInt(count), 24);
  zip64End.writeBigUInt64LE(BigInt(count), 32);
  zip64End.writeBigUInt64LE(centralSize, 40);
  zip64End.writeBigUInt64LE(centralOffset, 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(archiveOffset, 8);
  locator.writeUInt32LE(1, 16);
  return [zip64End, locator, end];
}

export async function validateZipSource(file, stat) {
  // The open descriptor must still match the owned path resolved at discovery.
  const expected = file.expectedStat;
  if (stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino && stat.size === expected.size
    && stat.mtimeMs === expected.mtimeMs && stat.ctimeMs === expected.ctimeMs
    && await fs.promises.realpath(file.path).catch(() => null) === file.path) return;
  throw Object.assign(new Error("ZIP source changed before reading"), { code: "ZIP_SOURCE_CHANGED", statusCode: 404 });
}

async function openValidatedZipSource(file, stopped) {
  const handle = await fs.promises.open(file.path, "r");
  let stream;
  try {
    if (stopped()) return null;
    const stat = await handle.stat();
    if (stopped()) return null;
    await validateZipSource(file, stat);
    if (stopped()) return null;
    stream = handle.createReadStream();
    return stream;
  } finally {
    if (!stream) await handle.close();
  }
}

export async function streamStoredZip(res, files = []) {
  if (res.destroyed || res.writableEnded) return false;
  const entries = [];
  let offset = 0n;
  let source = null, sourceClosed = null, failure = null, stopped = false;
  const unavailable = () => stopped || res.destroyed || res.writableEnded;
  const cancel = () => { stopped = true; source?.destroy(); };
  const fail = (error) => {
    failure ||= error;
    cancel();
    if (!res.destroyed) res.destroy();
  };
  async function write(buffer) {
    if (failure) throw failure;
    if (stopped) return false;
    const written = await writeBuffer(res, buffer);
    if (failure) throw failure;
    return written && !stopped;
  }
  async function closeSource() {
    if (!source) return;
    source.destroy();
    // ReadStream close follows its fs.close callback, including a read that
    // was still pending when the response disconnected.
    await sourceClosed;
    source.off("error", fail);
    source = null; sourceClosed = null;
  }
  res.on("close", cancel);
  res.on("error", fail);
  try {
    for (const file of files) {
      if (unavailable()) return false;
      const name = Buffer.from(String(file.name || "chapter.zip").replace(/\\/g, "/"), "utf8");
      const stat = file.expectedStat ?? fs.statSync(file.path);
      if (!stat.isFile()) continue;
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new RangeError("Invalid ZIP source size");
      const { date, time } = dosDateTime(stat.mtime);
      const start = offset;
      const largeSize = stat.size >= ZIP32_SIZE_LIMIT;
      // The signed data descriptor carries the final sizes for this stream.
      const extra = largeSize ? zip64Extra(0, 0) : null;
      const header = localHeader(name, date, time, extra);
      if (!(await write(header)) || !(await write(name))) return false;
      if (extra && !(await write(extra))) return false;
      offset += BigInt(header.length + name.length + (extra?.length ?? 0));
      let crc = 0;
      let size = 0;
      source = file.expectedStat ? await openValidatedZipSource(file, unavailable) : fs.createReadStream(file.path);
      if (!source) return false;
      sourceClosed = source.closed ? Promise.resolve() : new Promise(resolve => source.once("close", resolve));
      // A source error must also interrupt a pending response drain.
      source.on("error", fail);
      try {
        for await (const chunk of source) {
          size += chunk.length;
          crc = crc32(chunk, crc);
          if (!(await write(chunk))) return false;
        }
      } finally { await closeSource(); }
      if (size !== stat.size) throw Object.assign(new Error("ZIP source changed while reading"), { code: "ZIP_SOURCE_CHANGED" });
      const descriptor = dataDescriptor(crc, size, largeSize);
      if (!(await write(descriptor))) return false;
      offset += BigInt(size) + BigInt(descriptor.length);
      entries.push({ name, date, time, crc, size, largeSize, offset: start });
    }

    const centralOffset = offset;
    for (const entry of entries) {
      const { header, extra } = centralHeader(entry);
      if (!(await write(header)) || !(await write(entry.name))) return false;
      if (extra && !(await write(extra))) return false;
      offset += BigInt(header.length + entry.name.length + (extra?.length ?? 0));
    }
    for (const end of endRecords(entries.length, centralOffset, offset)) {
      if (!(await write(end))) return false;
    }
    if (!res.destroyed && !res.writableEnded) res.end();
    return true;
  } catch (error) {
    if (failure || !stopped) {
      if (!res.destroyed) res.destroy();
      throw failure || error;
    }
    return false;
  } finally {
    await closeSource();
    res.off("close", cancel);
    res.off("error", fail);
  }
}
