import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createVideoProbeCacheService } from "../src/platform/server/video-probe-cache-service.js";
import { createVideoProbeService } from "../src/platform/server/video-probe-service.js";

// Native private :memory: owners and synthetic source identities only.
// The playback integration must use durable hits, without stat or FFprobe.
assert(process.argv.slice(2).every(arg => ["--legacy-prepared-owner", "--legacy-invalid-state-reset"].includes(arg)));
const legacyOwner = process.argv.includes("--legacy-prepared-owner");
const legacyReset = process.argv.includes("--legacy-invalid-state-reset");
assert(!(legacyOwner && legacyReset), "one isolated control per run");
const negative = legacyOwner || legacyReset;
const source = readFileSync(new URL("../src/platform/server/video-probe-cache-service.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const previousInitialize = `  function initialize() {
    if (initialized) return true;
    try {
      const db = getDb();
      withoutLockWait(db, () => initializeDatabase(db));
      cacheDatabase = db;
      initialized = true;
      return true;
    } catch (error) {
      warn("[video-probe-cache]", error?.message || error);
      return false;
    }
  }

`;
const begin = source.indexOf("  function initialize() {"), end = source.indexOf("  function initializeDatabase(db) {", begin);
assert(begin > 0 && end > begin);
const initialize = source.slice(begin, end);
const resetHook = '      if (error?.code === "ERR_INVALID_STATE") resetPreparedOwner();\n';
assert.equal(source.split(resetHook).length, 3, "only native invalid-state read/write hooks change");
const previousSource = source.replace(initialize, previousInitialize).replaceAll(resetHook, "");
const beforeRead = '      warn("[video-probe-cache-read]", error?.message || error);';
const beforeWrite = '      warn("[video-probe-cache-write]", error?.message || error);';
assert.equal(previousSource.replace(previousInitialize, initialize).replace(beforeRead, resetHook + beforeRead)
  .replace(beforeWrite, resetHook + beforeWrite), source, "complete original initialization and error behavior restores byte-for-byte");
const previousFactory = (await import(`data:text/javascript;base64,${Buffer.from(previousSource).toString("base64")}`)).createVideoProbeCacheService;
const resetOnlyFactory = (await import(`data:text/javascript;base64,${Buffer.from(source.replaceAll(resetHook, "")).toString("base64")}`)).createVideoProbeCacheService;
const selectedFactory = legacyOwner ? previousFactory : legacyReset ? resetOnlyFactory : createVideoProbeCacheService;
const signature = { size: 1, cacheMtime: "library:fixture-v1" };
const file = i => ({ id: "v" + i, path: `synthetic/v${i}.mp4`, ext: ".mp4", size: 1, modifiedAt: "fixture-v1" });
const nativePrepare = DatabaseSync.prototype.prepare, nativeExec = DatabaseSync.prototype.exec;
const databases = [], services = [];
let responseOracles = 0, recoveryCases = 0, integrationOracles = 0;
function database() {
  const db = new DatabaseSync(":memory:"), counts = { initialization: 0, readPrepares: 0, writePrepares: 0, reads: 0, writes: 0, fullReads: 0 };
  nativeExec.call(db, "PRAGMA busy_timeout = 137");
  const owner = { db, counts, fault: null };
  databases.push(owner);
  db.exec = sql => {
    if (sql.includes("CREATE TABLE IF NOT EXISTS video_probe_cache")) {
      counts.initialization++;
      if (owner.fault?.phase === "schema") throw owner.fault.error;
    }
    return nativeExec.call(db, sql);
  };
  db.prepare = sql => {
    const reader = /SELECT[\s\S]*FROM video_probe_cache/u.test(sql), writer = sql.includes("INSERT INTO video_probe_cache");
    if (reader) counts.readPrepares++;
    if (writer) counts.writePrepares++;
    if (owner.fault?.phase === (reader ? "readPrepare" : writer ? "writePrepare" : "other")) throw owner.fault.error;
    const statement = nativePrepare.call(db, sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        if (reader && key === "get") counts.reads++;
        if (reader && key === "all") counts.fullReads++;
        if (writer && key === "run") counts.writes++;
        if (owner.fault?.phase === (reader && key === "get" ? "read" : writer && key === "run" ? "write" : "other")) throw owner.fault.error;
        return value.apply(target, args);
      };
    } });
  };
  return owner;
}
const wait = owner => nativePrepare.call(owner.db, "PRAGMA busy_timeout").get().timeout;
const raw = (owner, sql, ...args) => nativePrepare.call(owner.db, sql).run(...args);
function cache(factory = selectedFactory, owner = database()) {
  const state = { owner, providerError: null, providerReads: 0, warnings: [] };
  const service = factory({ getDb() { state.providerReads++; if (state.providerError) throw state.providerError; return state.owner.db; },
    now: () => "fixture-time", warn: (...args) => state.warnings.push(args) });
  return { state, service };
}
function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), label + " complete JSON"); responseOracles++;
}
function main(persistentCache) {
  const service = createVideoProbeService({ persistentCache, directVideoExts: new Set([".mp4"]), ffprobePath: "unused", hasNvenc: false,
    safeStat() { assert.fail("durable library identities require zero stat"); }, statFile() { assert.fail("zero async stat"); },
    execFileFn() { assert.fail("durable hits require zero probe process"); }, spawnSyncFn() { assert.fail("zero sync probe process"); } });
  services.push(service); return service;
}
try {
  const old = cache(previousFactory), current = cache();
  for (let i = 0; i < 1200; i++) {
    const value = i % 5 ? { duration: i + 1, videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080 } : null;
    equal(current.service.set(file(i), signature, value), old.service.set(file(i), signature, value), "healthy native writes");
  }
  for (let i = 0; i < 1300; i++) for (const stat of [signature, { ...signature, size: 2 }, { ...signature, cacheMtime: "changed" }])
    equal(current.service.get(file(i), stat), old.service.get(file(i), stat), "healthy complete hit/miss and signature behavior");
  for (const owner of [old.state.owner, current.state.owner]) {
    assert.equal(owner.counts.initialization, 1);
    assert.equal(owner.counts.readPrepares, 1); assert.equal(owner.counts.writePrepares, 1);
    assert.equal(owner.counts.reads, 3900); assert.equal(owner.counts.fullReads, 0, "no table snapshot is restored");
    assert.equal(wait(owner), 137, "every read and write restores the original busy timeout");
  }
  for (const patch of ["null", "[]", "123", '"text"', '{"duration":987}', "malformed"]) {
    for (const target of [old, current]) raw(target.state.owner, "UPDATE video_probe_cache SET probe_json=?,status='ok' WHERE file_id='v1'", patch);
    equal(current.service.get(file(1), signature), old.service.get(file(1), signature), "original JSON parse/fallback behavior");
  }
  for (const phase of ["read", "write"]) {
    const error = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
    for (const target of [old, current]) target.state.owner.fault = { phase, error };
    const operation = target => phase === "read" ? target.service.get(file(2), signature) : target.service.set(file(2), signature, { duration: 44 });
    equal(operation(current), operation(old), "transient original optional-cache fallback");
    for (const target of [old, current]) target.state.owner.fault = null;
    equal(operation(current), operation(old), "same owner transient recovery");
    assert.equal(current.state.owner.counts.readPrepares, 1, "busy errors do not discard healthy statements");
    assert.equal(current.state.owner.counts.writePrepares, 1);
  }
  const invalidBefore = { ...current.state.owner.counts }, providerBefore = current.state.providerReads;
  for (const input of [null, {}, { id: "x" }, { path: "x" }]) equal(current.service.get(input, signature), old.service.get(input, signature), "invalid source bypass");
  equal(current.service.get(file(1), null), old.service.get(file(1), null), "missing stat bypass");
  assert.deepEqual(current.state.owner.counts, invalidBefore);
  assert.equal(current.state.providerReads, providerBefore, "invalid inputs never resolve an owner");
  console.log(JSON.stringify({ healthyResponseOracles: responseOracles, current: current.state.owner.counts,
    previous: old.state.owner.counts, healthyPointStatementsRetained: true, negative }));

  for (const closeOld of [false, true]) {
    const target = cache(), original = target.state.owner;
    assert.equal(target.service.set(file(0), signature, { duration: 7 }), true);
    const replacement = database(); target.state.owner = replacement;
    if (closeOld) original.db.close();
    const initial = target.service.get(file(0), signature);
    if (legacyOwner) console.log(JSON.stringify({ defect: "replacement connection must not use old prepared rows", closeOld, actual: initial, expected: { hit: false, value: null } }));
    equal(initial, { hit: false, value: null }, "replacement starts from its own empty native table");
    assert.equal(target.service.set(file(0), signature, { duration: 43 }), true);
    equal(target.service.get(file(0), signature), { hit: true, value: { duration: 43 } }, "replacement read/write recovers immediately");
    assert.equal(replacement.counts.initialization, 1); assert.equal(replacement.counts.readPrepares, 1);
    assert.equal(replacement.counts.writePrepares, 1); assert.equal(wait(replacement), 137);
    assert.equal(original.counts.reads, 0, "replacement never reads the previous owner's row");
    assert.equal(original.counts.writes, 1, "replacement never writes the previous owner's row");
    if (!closeOld) {
      assert.equal(nativePrepare.call(original.db, "SELECT probe_json FROM video_probe_cache").get().probe_json, '{"duration":7}');
      target.state.owner = original;
      equal(target.service.get(file(0), signature), { hit: true, value: { duration: 7 } }, "switching back binds the original owner again");
      assert.equal(original.counts.initialization, 2);
    }
    recoveryCases++;
  }
  for (const phase of ["schema", "readPrepare", "writePrepare"]) {
    const target = cache(); assert.equal(target.service.set(file(0), signature, { duration: 7 }), true);
    const replacement = database(); target.state.owner = replacement;
    replacement.fault = { phase, error: new Error("controlled replacement " + phase) };
    equal(target.service.get(file(0), signature), { hit: false, value: null }, "failed replacement initialization cannot expose old rows");
    assert.equal(wait(replacement), 137, "partial initialization restores wait policy");
    replacement.fault = null;
    assert.equal(target.service.set(file(0), signature, { duration: 45 }), true, "next operation completes the new owner's initialization");
    equal(target.service.get(file(0), signature), { hit: true, value: { duration: 45 } }, "repaired replacement statement pair");
    assert.equal(replacement.counts.initialization, 2);
    assert.equal(target.state.warnings.length, 1); recoveryCases++;
  }
  const provider = cache(); assert.equal(provider.service.set(file(0), signature, { duration: 8 }), true);
  const counts = { ...provider.state.owner.counts };
  provider.state.providerError = new Error("provider temporarily unavailable");
  equal(provider.service.get(file(0), signature), { hit: false, value: null }, "provider failure never silently reads retained owner");
  assert.equal(provider.service.set(file(0), signature, { duration: 9 }), false);
  assert.deepEqual(provider.state.owner.counts, counts, "provider failure never silently writes retained owner");
  provider.state.providerError = null;
  equal(provider.service.get(file(0), signature), { hit: true, value: { duration: 8 } }, "same provider recovers without extra prepares");
  assert.equal(provider.state.owner.counts.initialization, 1); recoveryCases++;

  for (const kind of ["read", "write"]) for (const observedClosed of [false, true]) {
    const target = cache(); assert.equal(target.service.set(file(0), signature, { duration: 8 }), true);
    target.state.owner.db.close();
    if (observedClosed) {
      equal(target.service.get(file(0), signature), { hit: false, value: null }, "native closed owner remains optional fallback");
    }
    target.state.owner.db.open();
    const fresh = cache(createVideoProbeCacheService, target.state.owner);
    assert.equal(fresh.service.set(file(0), signature, { duration: 49 }), true);
    if (!observedClosed) {
      const first = kind === "read" ? target.service.get(file(0), signature) : target.service.set(file(0), signature, { duration: 50 });
      equal(first, kind === "read" ? { hit: false, value: null } : false, "finalized statement's first fallback is unchanged");
    }
    const reopened = target.service.get(file(0), signature);
    if (legacyReset) console.log(JSON.stringify({ defect: "finalized native statements must recover on the next operation", kind, observedClosed, actual: reopened, expected: { hit: true, value: { duration: 49 } } }));
    equal(reopened, { hit: true, value: { duration: 49 } }, "same native object reopened after invalid state reinitializes");
    assert.equal(target.service.set(file(0), signature, { duration: 50 }), true);
    assert.equal(target.service.get(file(0), signature).value.duration, 50); recoveryCases++;
  }
  const playbackCache = cache(); assert.equal(playbackCache.service.set(file(0), signature,
    { duration: 7, videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080 }), true);
  const replacement = database(); playbackCache.state.owner = replacement;
  const clean = cache(createVideoProbeCacheService, replacement);
  assert.equal(clean.service.set(file(0), signature, { duration: 43, videoCodec: "vp9", audioCodec: "aac", width: 1280, height: 720 }), true);
  const actualMain = main(playbackCache.service), expectedMain = main(clean.service);
  const actual = await actualMain.playInfoForFileAsync(file(0)), expected = await expectedMain.playInfoForFileAsync(file(0));
  equal(actual, expected, "entire actual playback payload follows the replacement durable cache"); integrationOracles++;
  assert.equal(actual.duration, 43);
  const beforeHot = replacement.counts.reads;
  equal(await actualMain.playInfoForFileAsync(file(0)), await expectedMain.playInfoForFileAsync(file(0)), "async hot playback DTO"); integrationOracles++;
  equal(actualMain.playInfoForFile(file(0)), expectedMain.playInfoForFile(file(0)), "sync hot playback DTO"); integrationOracles++;
  assert.equal(replacement.counts.reads, beforeHot, "parsed hot playback preserves zero persistent reads");
  console.log(JSON.stringify({ videoProbeCacheRecovery: "ok", responseOracles, recoveryCases, integrationOracles,
    privateDatabases: databases.length, noFullTableReads: databases.every(owner => owner.counts.fullReads === 0),
    healthyPrepareReuse: current.state.owner.counts, noRealProbeOrStat: true }));
} finally {
  for (const service of services) await service.stop();
  for (const owner of databases) if (owner.db.isOpen) owner.db.close();
}
