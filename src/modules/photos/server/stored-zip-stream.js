import fs from "node:fs";

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  CRC_TABLE[index] = value >>> 0;
}

function crcUpdate(crc, chunk) {
  let value = crc;
  for (const byte of chunk) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

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
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve(!res.destroyed && !res.writableEnded);
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

function localHeader(name, date, time) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0808, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt16LE(name.length, 26);
  return header;
}

function dataDescriptor(crc, size) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc >>> 0, 4);
  descriptor.writeUInt32LE(size >>> 0, 8);
  descriptor.writeUInt32LE(size >>> 0, 12);
  return descriptor;
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0808, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.date, 14);
  header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.size >>> 0, 20);
  header.writeUInt32LE(entry.size >>> 0, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(entry.offset >>> 0, 42);
  return header;
}

export async function streamStoredZip(res, files = []) {
  const entries = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(String(file.name || "chapter.zip").replace(/\\/g, "/"), "utf8");
    const stat = fs.statSync(file.path);
    if (!stat.isFile() || stat.size > 0xffffffff) continue;
    const { date, time } = dosDateTime(stat.mtime);
    const start = offset;
    const header = localHeader(name, date, time);
    if (!(await writeBuffer(res, header)) || !(await writeBuffer(res, name))) return false;
    offset += header.length + name.length;
    let crc = 0xffffffff;
    let size = 0;
    for await (const chunk of fs.createReadStream(file.path)) {
      crc = crcUpdate(crc, chunk);
      size += chunk.length;
      if (!(await writeBuffer(res, chunk))) return false;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = dataDescriptor(crc, size);
    if (!(await writeBuffer(res, descriptor))) return false;
    offset += size + descriptor.length;
    entries.push({ name, date, time, crc, size, offset: start });
  }

  const centralOffset = offset;
  for (const entry of entries) {
    const header = centralHeader(entry);
    if (!(await writeBuffer(res, header)) || !(await writeBuffer(res, entry.name))) return false;
    offset += header.length + entry.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralOffset, 12);
  end.writeUInt32LE(centralOffset, 16);
  if (!(await writeBuffer(res, end))) return false;
  if (!res.destroyed && !res.writableEnded) res.end();
  return true;
}
