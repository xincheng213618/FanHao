import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collapseDuplicateTracks, createDuplicateTrackAccumulator } from "../public/modules/music/format.js";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// The unchanged stateless function is an independent full-prefix oracle.
// Counters only surround the actual accumulator, never the oracle itself.
export function verifySearchDedupPure({ factory = createDuplicateTrackAccumulator, scenario = "" } = {}) {
  let checks = 0;
  if (!scenario || scenario === "budget") {
    const raw = scaleTracks();
    const accumulator = factory();
    let normalizations = 0, counting = false, previous = [], previousCopy = [];
    const normalize = String.prototype.normalize;
    String.prototype.normalize = function(form) { if (counting && form === "NFKC") normalizations++; return normalize.call(this, form); };
    try {
      for (let end = 120; end <= raw.length; end += 120) {
        counting = true; const current = accumulator.append(raw.slice(end - 120, end)); counting = false;
        assert.deepEqual(current, collapseDuplicateTracks(raw.slice(0, end)), "every incremental prefix must equal the complete stateless result, order and metadata");
        assert.deepEqual(previous, previousCopy, "a later append must not mutate a previously published snapshot");
        previous = current; previousCopy = structuredClone(current);
      }
    } finally { counting = false; String.prototype.normalize = normalize; }
    assert(normalizations > 0 && normalizations <= raw.length * 2,
      `incremental duplicate keys must normalize only newly ingested raw tracks, saw ${normalizations} NFKC calls for ${raw.length} tracks`);
    console.log("MUSIC_DEDUP_SCALE", JSON.stringify({ raw: raw.length, pageSize: 120, prefixes: 100, keyNormalizations: normalizations, oracle: "unchanged stateless full prefix", outputGroups: previous.length }));
    checks++;
  }
  if (!scenario || scenario === "edges") {
    const a = { ...sample("A", "Poison group"), favorite: true, rating: 1 };
    const b = { ...sample("B", "Poison group"), favorite: false, rating: 5, fileName: "b.flac" };
    const c = { ...sample("C", "Poison group"), favorite: true, rating: 3 };
    const equalFirst = { ...sample("equal-first", "Equal score"), edition: "first" };
    const equalLater = { ...sample("equal-later", "Equal score"), edition: "later" };
    const singleton = sample("singleton", "Singleton");
    const repeated = sample("repeated-id", "Repeated raw occurrence");
    const pages = [
      [a, singleton, equalFirst], [b, equalLater], [c],
      [sample("width-a", "ＡＬＰＨＡ ·Song"), sample("width-b", "alpha• song")],
      [{ ...sample("short-a", "Short"), durationMs: 9999 }, { ...sample("short-b", "Short"), durationMs: 9999 },
        { ...sample("boundary-a", "Boundary"), durationMs: 14999 }, { ...sample("boundary-b", "Boundary"), durationMs: 15000 }],
      [null, { title: "No ID" }, { ...sample("empty-artist-a", "No artist"), artist: "" }, { ...sample("empty-artist-b", "No artist"), artist: "" }, repeated, repeated],
      [{ ...sample("negative-a", "Negative"), rating: -4, playCount: -8 }, { ...sample("negative-b", "Negative"), rating: -2, playCount: -3 },
        { ...sample("nan-a", "NaN score"), rating: "not-a-number", playCount: "not-a-number" }, { ...sample("nan-b", "NaN score"), favorite: true, rating: 3, playCount: 4 },
        { ...sample("zero-a", "Signed zero"), rating: "-0", playCount: "-0" }, { ...sample("zero-b", "Signed zero"), rating: "-0", playCount: "-0" }]
    ];
    const accumulator = factory(), prefix = [];
    let firstSnapshot, firstCopy, snapshot;
    for (const page of pages) {
      for (const track of page) if (track) Object.freeze(track);
      prefix.push(...page); snapshot = accumulator.append(page);
      assert.deepEqual(snapshot, collapseDuplicateTracks(prefix), "edge prefixes must preserve first-group order, raw occurrences, raw representative scores and all aggregate fields");
      if (!firstSnapshot) { firstSnapshot = snapshot; firstCopy = structuredClone(snapshot); }
      assert.strictEqual(snapshot.find(track => track.id === singleton.id), singleton, "a singleton must retain its original source reference");
      assert.deepEqual(firstSnapshot, firstCopy, "later group promotion must not mutate an old published array or DTO");
    }
    const poison = snapshot.find(track => track.title === "Poison group");
    assert.equal(poison.id, "C", "representative scoring must use raw members rather than an aggregate DTO poisoned by another member's rating");
    assert.equal(poison.rating, 5); assert.deepEqual(poison.duplicateIds, ["A", "B", "C"]);
    assert.equal(snapshot.find(track => track.title === "Equal score").id, "equal-first", "equal scores must keep the earliest raw member");
    assert.deepEqual(accumulator.append(null), collapseDuplicateTracks(prefix));
    assert.deepEqual(accumulator.append([]), collapseDuplicateTracks(prefix));
    console.log("PASS pure duplicate edge prefixes, singleton identity, poison representative and immutable snapshots"); checks++;
  }
  if (!scenario || scenario === "fresh") {
    const first = factory(), firstItems = [sample("session-a", "Same session key"), sample("session-a2", "Same session key")];
    const firstResult = first.append(firstItems), saved = structuredClone(firstResult);
    const second = factory(), secondItems = [sample("session-b", "Same session key")];
    assert.deepEqual(second.append(secondItems), collapseDuplicateTracks(secondItems), "a fresh accumulator session must contain no groups or member IDs from an earlier search");
    assert.deepEqual(first.append([]), collapseDuplicateTracks(firstItems)); assert.deepEqual(firstResult, saved);
    console.log("PASS pure fresh search sessions stay isolated"); checks++;
  }
  return { checks };
}
function sample(id, title) { return { id, title, artist: "Synthetic Artist", album: `Album ${id}`, durationMs: 180000, fileName: `${id}.mp3`, favorite: false, rating: 0, playCount: 0, sizeBytes: 10000, sampleRate: 44100, bitDepth: 0, hasLyrics: false }; }
function scaleTracks() {
  return Array.from({ length: 12000 }, (_, index) => {
    const group = index % 3000, version = Math.floor(index / 3000);
    return { ...sample(`g${group}-v${version}`, `Song ${group}`),
      title: version % 2 ? `Ｓｏｎｇ ${group}` : `Song ${group}`, artist: version % 2 ? "Ｓｙｎｔｈｅｔｉｃ·Artist" : "Synthetic Artist",
      fileName: version % 2 ? `${index}.flac` : `${index}.mp3`, favorite: version === 2 && group % 3 === 0,
      rating: (group + version) % 6, playCount: (group * 13 + version) % 101, bitDepth: version * 8 };
  });
}
export async function verifySearchActionsScale() {
  const originals = new Map(["window", "document", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const preferences = new Map(), raw = scaleTracks(), offsets = [];
  const storage = { getItem: key => preferences.get(key) ?? null, setItem: (key, value) => preferences.set(key, value) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  globalThis.window = { localStorage: storage, setTimeout, clearTimeout };
  globalThis.document = { querySelector: () => null, activeElement: null };
  const current = { ...sample("playing", "Already playing"), streamUrl: "/synthetic/playing" }, queue = [current];
  const state = { activeView: "music", music: { mode: "library", query: "Synthetic", current, queue,
    playlistsLoadedAt: Date.now(), smartPlaylistsLoadedAt: Date.now() } };
  const audio = { src: current.streamUrl, currentTime: 42, paused: false };
  const api = { async getTracks(params) {
    const offset = Number(params.get("offset") || 0); offsets.push(offset);
    assert.equal(params.get("q"), "Synthetic"); assert.equal(params.get("limit"), "120");
    return { tracks: raw.slice(offset, offset + 120), total: raw.length, hasMore: offset + 120 < raw.length };
  } };
  const view = new Proxy({}, { get: () => () => false });
  let counting = false, normalizations = 0;
  const normalize = String.prototype.normalize;
  String.prototype.normalize = function(form) { if (counting && form === "NFKC") normalizations++; return normalize.call(this, form); };
  try {
    const { createMusicActions } = await import("../public/modules/music/actions.js");
    const actions = createMusicActions({ state, api, view, player: { getAudio: () => audio, load() { assert.fail("list appends must not reload current audio"); } },
      router: { push() { assert.fail("scoped list calls must not navigate"); }, replace() { assert.fail("scoped list calls must not navigate"); } },
      showError(error) { throw error; } });
    for (let offset = 0; offset < raw.length; offset += 120) {
      counting = true;
      try { await actions.loadMusic({ append: offset > 0, keepCurrent: true, restoreLast: false, skipRoute: true }); }
      finally { counting = false; }
      assert.deepEqual(state.music.data.tracks, collapseDuplicateTracks(raw.slice(0, offset + 120)), "actual actions must publish the stateless oracle for every accepted raw prefix");
      assert.equal(state.music.data.rawLoaded, offset + 120);
      assert.deepEqual(state.music.queue, queue); assert.equal(state.music.current.id, current.id);
      assert.deepEqual(audio, { src: "/synthetic/playing", currentTime: 42, paused: false });
    }
    assert.deepEqual(offsets, Array.from({ length: 100 }, (_, index) => index * 120), "actions paging must advance by raw 120-row pages, never merged groups");
    assert(normalizations > 0 && normalizations <= raw.length * 4,
      `actual search actions must reuse their accumulator instead of cold-seeding every append, saw ${normalizations} NFKC calls`);
    console.log("MUSIC_DEDUP_ACTIONS_SCALE", JSON.stringify({ raw: raw.length, pageSize: 120, requests: offsets.length, keyNormalizations: normalizations, includesFirstAppendSeed: true, outputGroups: state.music.data.tracks.length }));
  } finally {
    counting = false; String.prototype.normalize = normalize;
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pattern = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "", negativeOnly = process.argv.includes("--negative-only"), pureOnly = process.argv.includes("--pure-only");
  assert(!(negativeOnly && pattern) && !(pureOnly && pattern) && !(pureOnly && negativeOnly), "--case, --negative-only and --pure-only cannot be combined");
  if (!negativeOnly) {
    if (!pattern) { assert.equal(verifySearchDedupPure().checks, 3); await verifySearchActionsScale(); }
    if (!pureOnly) { const result = await runMusicReaderFixture({ casePattern: pattern || "search append " }); if (!pattern) assert.equal(result.checks, 6); }
  }
  if (!pattern && !pureOnly) {
    assert.throws(() => verifySearchDedupPure({ scenario: "budget", factory: () => {
      let prefix = []; return { append(incoming) { prefix = [...prefix, ...incoming]; return collapseDuplicateTracks(prefix); } };
    } }), { name: "AssertionError", message: /incremental duplicate keys must normalize only newly ingested raw tracks/ });
    console.log("PASS negative control detects repeated full-prefix collapse");
    const actionPath = "/modules/music/actions.js", source = fs.readFileSync(new URL("../public/modules/music/actions.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
    const rawSync = "    if (Array.isArray(music().data?.rawTracks)) {\n      music().data.rawTracks = music().data.rawTracks.map((track) => (track?.id === updated.id ? { ...track, ...updated } : track));\n    }";
    assert.equal(source.split(rawSync).length, 2, "raw-confirmation negative must remove one actual update block");
    await assert.rejects(() => runMusicReaderFixture({ casePattern: "search append confirmed writes", sourceOverrides: { [actionPath]: source.replace(rawSync, "") } }),
      { name: "AssertionError", message: /a confirmed search metadata write must update its matching raw member before another append/ });
    console.log("PASS negative control detects missing confirmed raw-member update");
    let shared;
    assert.throws(() => verifySearchDedupPure({ scenario: "fresh", factory: () => shared ||= createDuplicateTrackAccumulator() }),
      { name: "AssertionError", message: /a fresh accumulator session must contain no groups or member IDs from an earlier search/ });
    console.log("PASS negative control detects globally shared search groups");
  }
  console.log(`Music search deduplication passed (${pattern ? "selected browser family" : pureOnly ? "4 pure/actions behavior families" : negativeOnly ? "3 independent negative controls" : "4 pure/actions + 6 browser families + 3 independent negative controls"})`);
}
