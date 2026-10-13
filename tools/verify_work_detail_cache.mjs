import assert from "node:assert/strict";
import fs from "node:fs";
import { createWorkPresenterService } from "../src/modules/fanhao/server/works/presenter-service.js";
import { createWorkInfoService } from "../src/modules/fanhao/server/works/work-info-service.js";

// Actual detail service + presenter, synthetic metadata/files only. The private
// source hooks expose cache accounting without adding a production debug API.
assert.ok(process.argv.slice(2).every(value => value === "--legacy-budget"));
const legacy = process.argv.includes("--legacy-budget");
const source = fs.readFileSync(new URL("../src/modules/fanhao/server/works/work-detail-service.js", import.meta.url), "utf8");
const admissionStart = source.indexOf("    const bytes = detailPayloadWeight(payload);");
const admissionEnd = source.indexOf("    return payload;", admissionStart);
assert.ok(admissionStart > 0 && admissionEnd > admissionStart);
const previousSource = (source.slice(0, admissionStart)
  + "    detailCache.set(cacheKey, payload);\n    while (detailCache.size > WORK_DETAIL_CACHE_LIMIT) detailCache.delete(detailCache.keys().next().value);\n"
  + source.slice(admissionEnd)).replace("return cached.payload;", "return cached;");
async function load(text, previous = false) {
  const hook = "    detailPayload,";
  assert.equal(text.split(hook).length, 2);
  text = "let weightCalls = 0, weightVisits = 0;\n" + text;
  text = text.replace("function detailPayloadWeight(payload) {", "function detailPayloadWeight(payload) { weightCalls++;");
  text = text.replace("function visit(value) {", "function visit(value) { weightVisits++;");
  text = text.replace(hook, `    snapshot: () => ({ entries: detailCache.size, bytes: detailCacheBytes,
      accountedBytes: [...detailCache.values()].reduce((sum, entry) => sum + (entry.bytes || 0), 0), keys: [...detailCache.keys()],
      weightCalls, weightVisits, payloads: [...detailCache.values()].map(entry => ${previous ? "entry" : "entry.payload"}) }),\n${hook}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`)).createWorkDetailService;
}
const createCurrent = await load(legacy ? previousSource : source, legacy);
const createPrevious = await load(previousSource, true);
const MAX_BYTES = 32 * 1024 * 1024;
const parse = value => { try { return JSON.parse(value || "[]"); } catch { return []; } };
const info = createWorkInfoService({
  getCoreDb: () => { throw new Error("This fixture must not open a database"); }, getStamp: () => "fixture",
  displayWorkTitle: value => value || "", parseJsonArray: parse, parseJsonTextArray: parse,
  proxiedRemoteImageUrl: value => value || "", proxiedRemoteImageUrlArray: value => value || [],
  publicRemoteUrl: value => value || "", renderInfoMetadataText: () => "Rendered fields", uniqueTextArray: value => [...new Set(value || [])]
});
let completeComparisons = 0;

function fixture(create, specs = {}, customize = value => value) {
  const target = { materializations: 0, people: 0, covers: 0, remote: 0, probes: 0,
    stamps: { works: "works-1", people: "people-1", user: "owner-a:1" } };
  const person = { id: "person", name: "Synthetic", sourcePaths: ["fixture"], works: [] };
  const library = { scannedAt: "scan-1", peopleById: new Map([[person.id, person]]), filesById: new Map() };
  const progress = { getWorkProgress: () => ({ videoId: "preferred", owner: target.stamps.user }),
    getVideoProgress: id => ({ videoId: id, owner: target.stamps.user }) };
  const presenter = createWorkPresenterService({
    getLibrary: () => library, displayPersonForWork: () => person, actorProfileRow: () => null,
    publicActorProfile: () => null, publicActorProfileSnapshot: () => ({
      profile: specs.actorChars ? { biography: "中".repeat(specs.actorChars) } : null, avatar: { avatarUrl: "/fixture-avatar" } }),
    publicCoreWorkCover: () => null, manualCoverStateService: { manualCoverForWork: () => null },
    favoriteStateService: { publicFavoriteForWork: () => ({ folderId: target.stamps.user, folderName: "Fixture" }) },
    playbackProgressService: progress, localWorkMarkers: () => [], isGPerson: () => false,
    displayWorkTitle: value => value || "", publicWorkInfoSummary: info.publicSummary, publicWorkInfoMetadata: info.publicMetadata,
    workInfoDetailRow: id => ({ code: `CODE-${id}`, title: `Title ${id}`, raw_text: `Raw ${id}` + "中".repeat(specs.rawChars || 0),
      fields_json: specs.fields || '[{"name":"Field","value":"Value"}]' }),
    uniqueTextArray: value => [...new Set(value || [])], dbBoolOrNull: value => value == null ? null : Boolean(Number(value)),
    firstPresentValue: info.firstPresentValue, proxiedRemoteImageUrl: value => value || ""
  });
  const file = (id, type) => ({ id, type, name: `${id}.jpg`, title: `File ${id}`, ext: ".jpg", relativePath: `Fixture/${id}.jpg`,
    path: `C:/Synthetic-fixture/${"directory/".repeat(12)}${id}.jpg`, size: 1000, modifiedAt: "2026-01-01", playable: type === "video" });
  const work = id => id === "missing" ? null : ({ id: String(id).replace(/^alias-/, ""), personId: person.id,
    title: `Title ${id}`, directoryName: "Fixture", relativePath: "Fixture", videos: [file("first", "video"), file("preferred", "video")],
    infos: [file(`info-${id}`, "info")], images: Array.from({ length: specs.files || 0 }, (_, i) => file(`${id}:${i}`, "image")) });
  const service = create({ library, playbackProgressService: progress, peoplePayloadStamp: () => target.stamps.people,
    workQueryStamp: () => target.stamps.works, userStateStamp: () => target.stamps.user,
    prewarmCoreWorkCovers: () => { target.covers++; }, prewarmRemoteImagesForWorks: (_items, limit) => { assert.equal(limit, 100); target.remote++; },
    publicWork: (...args) => { target.materializations++; assert.equal(args[1], true); return customize(presenter.publicWork(...args)); },
    publicPerson: value => { target.people++; return presenter.publicPerson(value); }, resolveLibraryWorkByPublicId: work,
    videoProbeService: { prewarm(files, options) { target.probes++; assert.equal(files[0].id, "preferred");
      assert.deepEqual(options, { concurrency: 3, limit: 1, queueLimit: 8, replaceQueued: true }); return { queued: 1, active: 1, pending: 0 }; } }
  });
  return Object.assign(target, { service, library });
}
function compare(a, b, id) {
  assert.deepEqual(a.service.detailPayload(id), b.service.detailPayload(id)); completeComparisons++;
}
function bounded(f) {
  const state = f.service.snapshot(); assert.ok(state.entries <= 64); assert.ok(state.bytes >= 0 && state.bytes <= MAX_BYTES);
  assert.equal(state.bytes, state.accountedBytes, "eviction and stamp resets must keep the byte counter consistent with live entries");
  return state;
}

// Real complete DTOs: large text and file arrays independently exceed the old
// count-only retention. Responses stay complete while the cache admits fewer.
const measurements = [];
for (const specs of [{ rawChars: 1024 * 1024 }, { files: 1000 }]) {
  const before = fixture(createPrevious, specs), after = fixture(createCurrent, specs);
  for (let i = 1; i <= 64; i++) compare(after, before, String(i));
  const old = before.service.snapshot(), next = bounded(after);
  assert.equal(old.entries, 64);
  assert.ok(next.entries < 64, "large full DTOs must obey a byte budget, not only a 64-entry limit");
  const raw = state => state.payloads.reduce((n, value) => n + value.work.infoMetadata.rawText.length * 2, 0);
  const files = state => state.payloads.reduce((n, value) => n + value.work.images.length, 0);
  measurements.push({ scenario: specs.rawChars ? "text" : "files", previousEntries: old.entries, entries: next.entries,
    estimatedBytes: next.bytes, previousRawBytes: raw(old), rawBytes: raw(next), previousFileDtos: files(old), fileDtos: files(next) });
  after.service.detailPayload(next.keys[0]);
  compare(after, before, "65");
  assert.ok(bounded(after).keys.includes(next.keys[0]), "byte eviction preserves the recently touched detail");
  assert.ok(!after.service.snapshot().keys.includes(next.keys[1]), "byte eviction removes the least recently used detail");
}

const f = fixture(createCurrent), previous = fixture(createPrevious);
for (let i = 1; i <= 64; i++) compare(f, previous, String(i));
assert.equal(bounded(f).entries, 64, "small DTOs retain the original entry capacity");
const hot = f.service.detailPayload("1"), counts = { ...f }, weightBefore = f.service.snapshot().weightCalls;
assert.equal(f.service.detailPayload("alias-1"), hot, "public aliases share the canonical work cache key");
assert.deepEqual(f.service.playbackPrewarmPayload("1"), { ok: true, detailReady: true, workId: "1", videoId: "preferred", queued: 1, active: 1, pending: 0 });
assert.equal(f.materializations, counts.materializations); assert.equal(f.people, counts.people);
assert.equal(f.covers, counts.covers); assert.equal(f.remote, counts.remote);
assert.equal(f.service.snapshot().weightCalls, weightBefore, "hot details/prewarm must not estimate the DTO again");
f.service.detailPayload("65");
assert.ok(bounded(f).keys.includes("1")); assert.ok(!f.service.snapshot().keys.includes("2"));
const oldCalls = f.materializations; f.service.detailPayload("2"); assert.equal(f.materializations, oldCalls + 1);
for (const scope of ["scan", "works", "people", "user"]) {
  if (scope === "scan") f.library.scannedAt = "scan-2";
  else f.stamps[scope] += "-changed";
  const calls = f.materializations; const result = f.service.detailPayload("1");
  assert.equal(f.materializations, calls + 1); assert.equal(bounded(f).entries, 1);
  assert.equal(result.work.favoriteFolderId, f.stamps.user);
}
f.stamps.user = "owner-b:1"; const ownerB = f.service.detailPayload("1");
f.stamps.user = "owner-a:1"; const ownerA = f.service.detailPayload("1");
assert.notEqual(ownerA, ownerB); assert.notEqual(ownerA.work.progress.owner, ownerB.work.progress.owner);
const beforeMissing = f.service.snapshot(); assert.equal(f.service.detailPayload("missing"), null);
assert.equal(f.service.playbackPrewarmPayload("missing"), null); assert.deepEqual(f.service.snapshot(), beforeMissing);

// Oversize admissions do not evict a useful hot entry, or truncate responses.
let enormous = false;
const oversized = fixture(createCurrent, {}, value => { if (enormous) value.infoMetadata.rawText = "中".repeat(MAX_BYTES); return value; });
const small = oversized.service.detailPayload("small"), smallState = bounded(oversized);
enormous = true;
const large = oversized.service.detailPayload("large");
assert.equal(large.work.infoMetadata.rawText.length, MAX_BYTES);
assert.deepEqual(bounded(oversized).keys, ["small"]); assert.equal(oversized.service.snapshot().bytes, smallState.bytes);
assert.equal(oversized.service.detailPayload("small"), small);
const largeCalls = oversized.materializations; oversized.service.detailPayload("large"); assert.equal(oversized.materializations, largeCalls + 1);

const backing = new ArrayBuffer(20 * 1024 * 1024);
const binary = fixture(createCurrent, {}, value => {
  value.infoMetadata.rawText = new Uint8Array(backing, 0, 1);
  value.infoMetadata.fields = [new DataView(backing, 4, 1), backing];
  return value;
});
binary.service.detailPayload("binary");
assert.equal(bounded(binary).entries, 1); assert.ok(binary.service.snapshot().bytes >= backing.byteLength);
assert.ok(binary.service.snapshot().bytes < backing.byteLength + 100000, "shared binary backing is counted once per payload");
const hugeBacking = new ArrayBuffer(40 * 1024 * 1024);
const shortView = fixture(createCurrent, {}, value => { value.infoMetadata.rawText = new Uint8Array(hugeBacking, 0, 1); return value; });
assert.equal(shortView.service.detailPayload("short").work.infoMetadata.rawText.byteLength, 1);
assert.equal(bounded(shortView).entries, 0, "a short view retains its oversized backing allocation");

let accessorReads = 0, proxyReads = 0;
const unknownValues = [new Date(), new Proxy({}, { ownKeys() { proxyReads++; throw Error("must not inspect proxy"); } }),
  Object.defineProperty({}, "value", { enumerable: true, get() { accessorReads++; throw Error("must not invoke accessor"); } })];
for (const unknown of unknownValues) {
  const special = fixture(createCurrent, {}, value => { value.infoMetadata.fields = [unknown]; return value; });
  assert.equal(special.service.detailPayload("special").work.infoMetadata.fields[0], unknown);
  assert.equal(bounded(special).entries, 0);
}
assert.equal(accessorReads, 0); assert.equal(proxyReads, 0);
const shared = { text: "small" }; shared.self = shared;
const cyclic = fixture(createCurrent, {}, value => { value.infoMetadata.fields = [shared, shared]; return value; });
const cyclicResult = cyclic.service.detailPayload("cycle");
assert.equal(cyclicResult.work.infoMetadata.fields[0].self, shared); assert.equal(bounded(cyclic).entries, 1);
const sparse = fixture(createCurrent, {}, value => { value.infoMetadata.fields = new Array(MAX_BYTES); return value; });
const visits = sparse.service.snapshot().weightVisits;
assert.equal(sparse.service.detailPayload("sparse").work.infoMetadata.fields.length, MAX_BYTES);
assert.equal(bounded(sparse).entries, 0);
assert.ok(sparse.service.snapshot().weightVisits - visits < 500, "huge arrays must stop before enumerating their elements");

// Nested parsed metadata fields are included, and deeply nested/unusual input
// cannot make weighing add an exception to the formerly successful return.
const fields = fixture(createCurrent, { fields: JSON.stringify([{ name: "large", value: "中".repeat(1024 * 1024) }]) });
fields.service.detailPayload("fields"); assert.ok(bounded(fields).bytes > 2 * 1024 * 1024);
const deep = {}; let cursor = deep;
for (let i = 0; i < 20000; i++) { cursor.child = {}; cursor = cursor.child; }
const nested = fixture(createCurrent, {}, value => { value.infoMetadata.fields = [deep]; return value; });
assert.equal(nested.service.detailPayload("nested").work.infoMetadata.fields[0], deep); assert.equal(bounded(nested).entries, 0);
const largePerson = fixture(createCurrent, { actorChars: MAX_BYTES });
assert.equal(largePerson.service.detailPayload("person").person.actorProfile.biography.length, MAX_BYTES);
assert.equal(bounded(largePerson).entries, 0, "the budget includes the person DTO alongside the work DTO");

// Diagnostic only: time the exact helper on already-created DTOs, with no hard
// timing threshold and no response serialization in the measurement.
const { detailPayloadWeight: weigh } = await import(`data:text/javascript;base64,${Buffer.from(source + "\nexport { detailPayloadWeight };\n").toString("base64")}`);
const weightTimings = [];
for (const count of [0, 1000]) {
  const sample = fixture(createCurrent, { files: count }).service.detailPayload("timing");
  for (let i = 0; i < 20; i++) weigh(sample);
  const durations = [];
  for (let i = 0; i < 101; i++) { const start = performance.now(); weigh(sample); durations.push(performance.now() - start); }
  durations.sort((a, b) => a - b);
  weightTimings.push({ imageFiles: count, estimatedBytes: weigh(sample), medianMs: Number(durations[50].toFixed(4)), p95Ms: Number(durations[95].toFixed(4)) });
}
console.log(JSON.stringify({ ok: true, completeComparisons, maxEntries: 64, maxBytes: MAX_BYTES, measurements,
  hotMaterializations: 0, hotWeightCalculations: 0, stampScopes: 4, ownerSwitches: 2, binaryBackingBytes: backing.byteLength, weightTimings }));
