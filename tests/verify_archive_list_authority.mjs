import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { archiveDiskSignature } from "../src/platform/server/archive-image-service.js";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";

const args = process.argv.slice(2);
assert(args.every(value => ["--legacy-authority-selection", "--legacy-middle-read"].includes(value)), "known arguments");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerPath = "src/platform/server/archive-image-service.js";
const ownerFile = path.join(project, ownerPath);
const oldSource = execFileSync("git", ["show", `63c5fab243233e142cfd62c4eaf13812feb92405:${ownerPath}`], { cwd: project, encoding: "utf8" }).replace(/\r\n/g, "\n");
assert.equal(crypto.createHash("sha256").update(oldSource).digest("hex"), "a6dab37b5b64e60b2ffd53e60beba8452989f9837ef6efe694fe498ef2aae6c9");
let currentSource = fs.readFileSync(ownerFile, "utf8").replace(/\r\n/g, "\n");
function replaceOnce(source, slot, replacement) {
  assert.equal(source.split(slot).length, 2, `one production slot: ${slot}`);
  return source.replace(slot, replacement);
}
if (args.includes("--legacy-authority-selection")) {
  currentSource = replaceOnce(currentSource, "if (authority.valid) authority = cached.authority;", "/* Controlled former warm authority selection. */");
  currentSource = replaceOnce(currentSource, "if (native) authority = { db: authority.db, stamp: rowStamp(row), native: true, valid: true };", "/* Controlled former parsed-row authority selection. */");
}
if (args.includes("--legacy-middle-read")) {
  currentSource = replaceOnce(currentSource, "const sameNativeAuthority = context.isCurrent()", "const sameNativeAuthority = false && context.isCurrent()");
}
async function factory(source) {
  const resolved = source.replace(/from\s+(["'])(\.[^"']+)\1/g, (_match, _quote, relative) =>
    "from " + JSON.stringify(pathToFileURL(path.resolve(path.dirname(ownerFile), relative)).href));
  return (await import("data:text/javascript;base64," + Buffer.from(resolved).toString("base64"))).createArchiveImageService;
}
const beforeFactory = await factory(oldSource), currentFactory = await factory(currentSource);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-archive-list-authority-"));
const owners = [], databases = [];
const stringify = JSON.stringify, parse = JSON.parse;
let checks = 0, errorChecks = 0, serial = 0;
function rows(count, prefix = "image") {
  return Array.from({ length: count }, (_, index) => ({ path: `folder/合成_图集/${prefix}-${String(index).padStart(5, "0")}.jpg`,
    name: `${prefix}-${String(index).padStart(5, "0")}.jpg`, bytes: 1048576 + index, compressedBytes: 800000 + index }));
}
function gate() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function metrics() { return { indexReads: 0, indexBytes: 0, stats: 0, prepares: 0, pragmaReads: 0, execs: 0, parses: 0, payloadSerializations: 0, payloadBytes: 0 }; }
function owner(create, { count = 3, empty = false } = {}) {
  const source = path.join(temporary, `archive-${++serial}.zip`);
  fs.writeFileSync(source, "private");
  const signature = archiveDiskSignature(source, fs.statSync(source));
  const state = { currentDb: null, onRead: null, onStat: null, rowTransform: null, readError: null,
    reads: 0, stats: 0, legacyEffects: 0, helperCalls: 0, helperImages: rows(count, "helper"), beforeHelper: null, metric: null };
  function newDb(images = rows(count)) {
    const dbPath = path.join(temporary, `gallery-${++serial}.sqlite`);
    const service = createImageGalleryDbService({ dbPath, ensureDataDir() {} }), db = service.getDb();
    db.exec("PRAGMA journal_mode=WAL");
    const writer = new DatabaseSync(dbPath);
    const resource = { service, db, writer }; databases.push(resource);
    if (images) db.prepare(`INSERT INTO photo_set_image_indexes
      (archive_path,archive_size,archive_mtime_ms,archive_identity,image_count,images_json,indexer_version,indexed_at,updated_at)
      VALUES(?,?,?,?,?,?,3,'private','private')`).run(source, signature.archiveSize, signature.archiveMtimeMs, signature.archiveIdentity, images.length, stringify(images));
    const prepare = db.prepare.bind(db), exec = db.exec.bind(db);
    db.exec = (...values) => { if (state.metric) state.metric.execs++; return exec(...values); };
    db.prepare = sql => {
      if (state.metric) state.metric.prepares++;
      const statement = prepare(sql);
      return new Proxy(statement, { get(target, key) {
        if (key === "get") return (...values) => {
          const indexRead = sql.startsWith("SELECT * FROM photo_set_image_indexes");
          if (indexRead) {
            state.reads++; if (state.metric) state.metric.indexReads++;
            state.onRead?.(state);
            if (state.readError) throw state.readError;
          } else if (state.metric) state.metric.pragmaReads++;
          const row = target.get(...values);
          if (indexRead && state.metric && typeof row?.images_json === "string") state.metric.indexBytes += Buffer.byteLength(row.images_json);
          return indexRead && state.rowTransform ? state.rowTransform(row, state) : row;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
    return resource;
  }
  const initial = newDb(empty ? null : rows(count)); state.currentDb = initial.db;
  const archive = create({ getImageGalleryDb: () => state.currentDb,
    statFile: async file => { state.stats++; if (state.metric) state.metric.stats++; const value = await fs.promises.stat(file); await state.onStat?.(state); return value; },
    spawnProcess() {
      state.helperCalls++;
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      Promise.resolve().then(() => state.beforeHelper?.()).then(() => {
        child.stdout.write(stringify({ ok: true, images: state.helperImages, imageCount: state.helperImages.length })); child.emit("close", 0);
      }, error => { child.emit("error", error); child.emit("close", 1); });
      return child;
    }, warn() {}, archiveImageExts: new Set([".jpg"]), listCacheTtlMs: 60_000 });
  const result = { archive, state, source, signature, initial, newDb,
    setImages(images, resource = initial) { resource.writer.prepare("UPDATE photo_set_image_indexes SET images_json=?,image_count=?").run(stringify(images), images.length); },
    read(options) { return archive.archiveImagesPayload(source, options); } };
  owners.push(result); return result;
}
async function measure(target, operation = () => target.read()) {
  const metric = metrics(); target.state.metric = metric;
  JSON.stringify = (value, ...args) => { const result = stringify(value, ...args); if (Array.isArray(value?.images)) { metric.payloadSerializations++; metric.payloadBytes += Buffer.byteLength(result); } return result; };
  JSON.parse = (...values) => { metric.parses++; return parse(...values); };
  try { return { value: await operation(), ...metric }; }
  finally { JSON.stringify = stringify; JSON.parse = parse; target.state.metric = null; }
}
async function equal(before, current, options, label) {
  const left = await before.read(options), right = await current.read(options);
  assert.deepEqual(right, left, label); assert.equal(stringify(right), stringify(left), `${label} wire order`);
  assert.equal(current.archive.diagnostics().listCacheBytes, before.archive.diagnostics().listCacheBytes, `${label} byte weight`);
  checks++; return { left, right };
}
async function verifyContracts() {
  const before = owner(beforeFactory), current = owner(currentFactory);
  await equal(before, current, {}, "cold native");
  for (const options of [{}, { limit: 1 }, { limit: 1.9 }, { limit: -1 }, { limit: "bad" }, { limit: Infinity }]) await equal(before, current, options, "warm limit " + stringify(options));
  const exposed = [];
  for (const target of [before, current]) {
    const images = await target.archive.listArchiveImages(target.source); exposed.push(images);
    images[0].name = "mutable " + "x".repeat(100000);
  }
  await equal(before, current, {}, "mutable shared member");
  for (let index = 0; index < 2; index++) {
    const target = [before, current][index], full = exposed[index];
    assert.equal(await target.archive.listArchiveImages(target.source), full);
    const limited = await target.read({ limit: 1 }); assert.notEqual(limited.images, full); assert.equal(limited.images[0], full[0]);
    const bytes = target.archive.diagnostics().listCacheBytes;
    full.push(full); await assert.rejects(target.read(), TypeError); assert.equal(target.archive.diagnostics().listCacheBytes, bytes); errorChecks++;
    target.state.reads = 0; target.state.onRead = state => { if (state.reads === 1) throw new Error("single SELECT failure"); };
    assert.equal((await target.read()).images, full, "failed initial authority retains the exposed cyclic list without recharging");
    assert.equal(target.archive.diagnostics().listCacheBytes, bytes); checks++;
    target.state.onRead = null; full.pop();
    full[0].unsupported = 1n; await assert.rejects(target.read(), TypeError); errorChecks++; delete full[0].unsupported;
  }
  for (const images of [rows(2, "changed"), [], rows(4, "restored")]) {
    before.setImages(images); current.setImages(images); await equal(before, current, {}, "external WAL update");
  }
  for (const target of [before, current]) target.initial.writer.exec("ALTER TABLE photo_set_image_indexes ADD COLUMN extra_metadata TEXT; UPDATE photo_set_image_indexes SET extra_metadata='new'");
  await equal(before, current, {}, "same-owner DDL invalidates authority");
  for (const target of [before, current]) target.initial.writer.exec("UPDATE photo_set_image_indexes SET extra_metadata=NULL");
  await equal(before, current, {}, "native NULL metadata");
  for (const target of [before, current]) target.archive.clearListCache();
  await equal(before, current, {}, "clear cache cold reload");
  for (const target of [before, current]) { await target.archive.stop(); await assert.rejects(target.read(), error => error.code === "ARCHIVE_READER_STOPPED"); errorChecks++; await target.archive.start(); }
  await equal(before, current, {}, "restart owner");
}
async function verifyLegacy() {
  for (const transform of [row => ({ ...row }), row => new Proxy(row, {}), row => {
    const copy = Object.assign(Object.create(null), row), text = row.images_json;
    Object.defineProperty(copy, "images_json", { enumerable: true, get: () => text }); return copy;
  }, row => Object.assign(Object.create(null), row, { toJSON: () => ({ ...row }) }), (row, state) => {
    const copy = Object.assign(Object.create(null), row);
    copy.toJSON = function () { state.legacyEffects++; delete this.toJSON; return this; }; return copy;
  }, (row, state) => {
    const copy = Object.assign(Object.create(null), row), text = row.images_json;
    Object.defineProperty(copy, "images_json", { enumerable: true, configurable: true, get() {
      state.legacyEffects++; Object.defineProperty(copy, "images_json", { value: text, enumerable: true, configurable: true }); return text;
    } }); return copy;
  }]) {
    const before = owner(beforeFactory), current = owner(currentFactory);
    before.state.rowTransform = current.state.rowTransform = transform;
    await equal(before, current, {}, "legacy cold");
    const left = await measure(before), right = await measure(current);
    assert.deepEqual(right.value, left.value); assert.equal(right.indexReads, 3); assert.equal(right.indexReads, left.indexReads);
    assert.equal(current.state.legacyEffects, before.state.legacyEffects, "legacy self-mutating hooks retain their observations");
    assert.equal(right.payloadSerializations, 1); checks++;
  }
  // Native scalar NULL/number images_json can still describe the legacy empty list.
  for (const value of [null, 0, "[]"]) {
    const before = owner(beforeFactory), current = owner(currentFactory);
    for (const target of [before, current]) {
      target.initial.writer.exec(`ALTER TABLE photo_set_image_indexes RENAME TO old_index;
        CREATE TABLE photo_set_image_indexes(archive_path TEXT PRIMARY KEY,archive_size INTEGER,archive_mtime_ms REAL,archive_identity TEXT,
          image_count INTEGER,images_json,indexer_version INTEGER,indexed_at TEXT,updated_at TEXT);
        INSERT INTO photo_set_image_indexes SELECT * FROM old_index; DROP TABLE old_index;`);
      target.initial.writer.prepare("UPDATE photo_set_image_indexes SET images_json=?").run(value);
    }
    await equal(before, current, {}, "native scalar images type");
    const measured = await measure(current);
    assert.equal(measured.indexReads, args.includes("--legacy-middle-read") ? 3 : 2); checks++;
  }
  const before = owner(beforeFactory), current = owner(currentFactory);
  for (const target of [before, current]) target.initial.writer.exec("ALTER TABLE photo_set_image_indexes ADD COLUMN legacy_blob BLOB; UPDATE photo_set_image_indexes SET legacy_blob=x'0102'");
  await equal(before, current, {}, "native BLOB metadata retains fallback");
  assert.equal((await measure(current)).indexReads, 3); checks++;
}
async function verifyRace(warm) {
  const before = owner(beforeFactory, { count: 1 }), current = owner(currentFactory, { count: 1 });
  const a = [{ path: "A.jpg", bytes: 1 }], b = [{ path: "B.jpg", bytes: 2 }];
  for (const target of [before, current]) {
    target.setImages(b); if (warm) await target.read();
    target.state.reads = 0; target.state.stats = 0;
    target.state.onRead = state => { if (state.reads === 1) target.setImages(a); if (state.reads === 2) target.setImages(b); };
    const finalStat = gate(), release = gate();
    target.state.onStat = async state => { if (state.stats === 2) { finalStat.resolve(); await release.promise; } };
    const reading = target.read(); await finalStat.promise;
    target.setImages(a); release.resolve();
    assert.equal((await reading).images[0].path, "B.jpg", "this request may return its observed B snapshot");
    target.state.onRead = null; target.state.onStat = null;
  }
  assert.equal((await before.read()).images[0].path, "B.jpg", "frozen old owner demonstrates the ABA stale admission");
  assert.equal((await current.read()).images[0].path, "A.jpg", `${warm ? "warm" : "cold"} native payload must not be bound to unrelated A authority`);
  checks++;
}
async function verifyBoundaries() {
  const before = owner(beforeFactory), current = owner(currentFactory);
  await equal(before, current, {}, "boundary warmup");
  for (const target of [before, current]) {
    const old = await target.read(), replacement = target.newDb(rows(2, "replacement"));
    target.state.stats = 0; target.state.onStat = state => { if (state.stats === 2) target.state.currentDb = replacement.db; };
    assert.deepEqual(await target.read(), old, "request retains its observed old DB snapshot");
    target.state.onStat = null;
    assert.equal((await target.read()).images[0].path, rows(2, "replacement")[0].path, "new DB owner reloads images"); checks++;
    target.state.currentDb = target.initial.db;
  }
  await equal(before, current, {}, "original DB owner return");
  const clock = Date.now; let now = clock();
  try {
    Date.now = () => now;
    for (const target of [before, current]) target.archive.clearListCache();
    const initial = await equal(before, current, {}, "TTL initial"); now += 59_999;
    const hit = await equal(before, current, {}, "TTL live"); assert.equal(hit.left.images, initial.left.images); assert.equal(hit.right.images, initial.right.images);
    now += 60_000;
    const expired = await equal(before, current, {}, "TTL expired"); assert.notEqual(expired.left.images, hit.left.images); assert.notEqual(expired.right.images, hit.right.images);
    now -= 1; await equal(before, current, {}, "clock rollback retains existing policy");
  } finally { Date.now = clock; }
  for (const target of [before, current]) {
    target.state.stats = 0; target.state.onStat = state => { if (state.stats === 1) fs.writeFileSync(target.source, "changed physical source"); };
    await assert.rejects(target.read(), error => error.code === "ARCHIVE_READER_SOURCE_CHANGED"); errorChecks++;
    target.state.onStat = null;
  }
  const generated = owner(currentFactory, { empty: true });
  await generated.read(); assert.equal(generated.state.helperCalls, 1);
  const warmed = await measure(generated); assert.equal(warmed.indexReads, args.includes("--legacy-middle-read") ? 3 : 2, "helper persistence refreshes the native authority qualification"); assert.equal(warmed.payloadSerializations, 1); checks++;
  const staleHelper = owner(currentFactory, { empty: true });
  staleHelper.state.beforeHelper = () => {
    staleHelper.initial.writer.prepare(`INSERT INTO photo_set_image_indexes(archive_path,archive_size,archive_mtime_ms,archive_identity,image_count,images_json,indexer_version,updated_at)
      VALUES(?,?,?,?,1,?,3,'external')`).run(staleHelper.source, staleHelper.signature.archiveSize, staleHelper.signature.archiveMtimeMs, staleHelper.signature.archiveIdentity, stringify([{ path: "external.jpg" }]));
  };
  assert.equal((await staleHelper.read()).images[0].path, rows(3, "helper")[0].path);
  assert.equal(parse(staleHelper.initial.writer.prepare("SELECT images_json FROM photo_set_image_indexes").get().images_json)[0].path, "external.jpg", "helper retains initial missing-row authority and cannot overwrite a newer index");
  assert.equal(staleHelper.archive.diagnostics().listEntries, 0); checks++;
}
async function verifyFailures() {
  const before = owner(beforeFactory), current = owner(currentFactory);
  await equal(before, current, {}, "native failure warmup");
  for (const target of [before, current]) target.initial.writer.exec("ALTER TABLE photo_set_image_indexes ADD COLUMN unsafe_integer INTEGER; UPDATE photo_set_image_indexes SET unsafe_integer=9007199254740992");
  await equal(before, current, {}, "native unsafe-integer decoding retains helper fallback");
  for (const target of [before, current]) {
    assert.equal(target.state.helperCalls, 1);
    target.initial.writer.exec("UPDATE photo_set_image_indexes SET unsafe_integer=NULL");
  }
  await equal(before, current, {}, "native decoding recovery");
  for (const target of [before, current]) target.initial.service.close();
  await equal(before, current, {}, "closed DB retains helper fallback without admission");
  for (const target of [before, current]) target.state.currentDb = target.newDb(rows(2, "reopened")).db;
  await equal(before, current, {}, "replacement DB after close");
  for (const target of [before, current]) {
    const reached = gate(), release = gate(); target.state.stats = 0;
    target.state.onStat = async state => { if (state.stats === 2) { reached.resolve(); await release.promise; } };
    const pending = target.read(), stopped = assert.rejects(pending, error => error.code === "ARCHIVE_READER_STOPPED");
    await reached.promise; target.archive.clearListCache();
    assert.equal(target.archive.diagnostics().listEntries, 0);
    release.resolve(); await stopped; target.state.onStat = null; errorChecks++;
  }
  await equal(before, current, {}, "fresh read after clear invalidates an in-flight owner");
}
async function verifyBudgets() {
  const distributions = [];
  for (const count of [1000, 5000]) {
    const before = owner(beforeFactory, { count }), current = owner(currentFactory, { count });
    await equal(before, current, {}, `scale ${count} cold`);
    const measures = [];
    for (const target of [before, current]) measures.push(await measure(target, async () => { let value; for (let index = 0; index < 100; index++) value = await target.read(); return value; }));
    assert.deepEqual(measures[1].value, measures[0].value); checks++;
    const imagesBytes = Buffer.byteLength(stringify(rows(count)));
    for (const [index, result] of measures.entries()) {
      assert.equal(result.indexReads, index ? 200 : 300, "100 warm requests reuse the initial native authority snapshot");
      assert.equal(result.indexBytes, (index ? 200 : 300) * imagesBytes);
      assert.equal(result.pragmaReads, result.indexReads); assert.equal(result.prepares, result.indexReads * 2); assert.equal(result.execs, result.indexReads * 2);
      assert.equal(result.stats, 200); assert.equal(result.parses, 0); assert.equal(result.payloadSerializations, 100);
    }
    assert.equal(measures[1].payloadBytes, measures[0].payloadBytes, "mutable cache byte charging still serializes the complete payload");
    const times = [[], []];
    for (let round = 0; round < 3; round++) for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const target = [before, current][index], start = performance.now();
      for (let request = 0; request < 100; request++) await target.read(); times[index].push(performance.now() - start);
    }
    distributions.push({ count, oldReads: measures[0].indexReads, reads: measures[1].indexReads, oldReadBytes: measures[0].indexBytes,
      readBytes: measures[1].indexBytes, payloadBytes: measures[1].payloadBytes, diagnostic100CallMs: times });
  }
  return distributions;
}
try {
  await verifyContracts(); await verifyLegacy(); await verifyRace(false); await verifyRace(true); await verifyBoundaries(); await verifyFailures();
  const distributions = await verifyBudgets();
  console.log(stringify({ fixture: "archive-list-authority", checks, errorChecks, distributions }, null, 2));
} finally {
  JSON.stringify = stringify; JSON.parse = parse;
  await Promise.allSettled(owners.map(owner => owner.archive.stop()));
  for (const resource of databases) { resource.writer.close(); resource.service.close(); }
  // Keep recursive cleanup in one native shell and verify the resolved target.
  if (process.platform === "win32") execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop'; $target=(Resolve-Path -LiteralPath $env:FANHAO_ARCHIVE_AUTHORITY_CLEANUP).ProviderPath; $temporary=(Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\\'); if (-not [string]::Equals([IO.Path]::GetDirectoryName($target),$temporary,[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid fixture parent' }; if (-not [IO.Path]::GetFileName($target).StartsWith('fanhao-archive-list-authority-')) { throw 'Invalid fixture name' }; Remove-Item -LiteralPath $target -Recurse -Force"],
    { env: { ...process.env, FANHAO_ARCHIVE_AUTHORITY_CLEANUP: temporary }, windowsHide: true });
}
