import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { appFunction } from "./fixtures/android-gallery-navigation-harness.mjs";
import { formatBytes, formatNumber } from "../android-client/www/js/format.js";

// Execute both complete shell rendering functions and their actual local
// display helper with controlled elements. No browser, service, storage scan,
// credentials, database or real media is accessed.
const source = fs.readFileSync(new URL("../android-client/www/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
let cases = 0;
const element = () => ({ textContent: "untouched", value: "unchanged", style: {},
  classList: { toggle() {} }, setAttribute() {} });

function fixture(code = source) {
  const names = ["renderMangaStorageMetrics", "renderMangaTrashItems", "renderReaderCacheMetrics"];
  if (/^function formatStorageMetricBytes\(/m.test(code)) names.unshift("formatStorageMetricBytes");
  const els = Object.fromEntries([
    "mangaStorageStatus", "mangaStorageBytes", "mangaStorageComics", "mangaStorageChapters", "mangaStorageImages",
    "mangaStorageHealth", "mangaStorageHealthStatus", "mangaStorageProgressTrack", "mangaStorageProgress", "mangaStorageIssues",
    "mangaTrashStatus", "mangaStorageHelp", "openMangaStorageButton", "clearMangaTrashButton",
    "readerCacheStatus", "readerCacheBytes", "readerCacheLimit", "readerCacheFiles", "readerCacheCleanup",
    "readerCacheProgress", "readerCacheProgressTrack", "readerCacheLimitInput"
  ].map(name => [name, element()]));
  const document = { activeElement: null };
  const context = vm.createContext({ els, document, formatBytes, formatNumber });
  vm.runInContext(names.map(name => appFunction(code, name)).join("\n"), context);
  return { els, document,
    manga: storage => context.renderMangaStorageMetrics(storage),
    reader: cache => context.renderReaderCacheMetrics(cache) };
}

function assertKnownZero(code = source, target = "all") {
  const f = fixture(code);
  if (target === "all" || target === "manga") {
    f.manga({ exists: true, bytes: 0 }); assert.equal(f.els.mangaStorageBytes.textContent, "0 B", "known empty manga library must show 0 B");
  }
  if (target === "all" || target === "reader") {
    f.reader({ currentBytes: 0, maxBytes: 1024 }); assert.equal(f.els.readerCacheBytes.textContent, "0 B", "known empty reader cache must show 0 B");
  }
  if (target === "all" || target === "limit") {
    f.reader({ currentBytes: 0, maxBytes: 0 }); assert.equal(f.els.readerCacheLimit.textContent, "0 B", "known zero cache limit must show 0 B");
  }
}

function check(name, run) {
  try { run(); cases++; }
  catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
}

check("known zero", () => assertKnownZero());
for (const value of [-0, 1, 1.5, 1023, 1024, 1024 ** 2, 200 * 1024 ** 3, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, Number.MIN_VALUE]) {
  check(`valid bytes ${Object.is(value, -0) ? "-0" : value}`, () => {
    const f = fixture(), expected = value === 0 ? "0 B" : formatBytes(value);
    f.manga({ exists: true, bytes: value }); f.reader({ currentBytes: value, maxBytes: value });
    for (const name of ["mangaStorageBytes", "readerCacheBytes", "readerCacheLimit"]) assert.equal(f.els[name].textContent, expected, `${name} preserves the existing positive-size format`);
  });
}

const invalid = [
  ["missing", undefined], ["null", null], ["empty string", ""], ["blank string", " "],
  ["numeric zero string", "0"], ["numeric nonzero string", "1024"], ["nonnumeric string", "unknown"],
  ["false", false], ["true", true], ["object", {}], ["empty array", []], ["array", [0]],
  ["NaN", NaN], ["Infinity", Infinity], ["negative Infinity", -Infinity],
  ["negative byte", -1], ["smallest negative", -Number.MIN_VALUE], ["large negative", -Number.MAX_VALUE]
];
for (const [label, value] of invalid) {
  check(`unknown or invalid ${label}`, () => {
    const f = fixture(); f.manga({ exists: true, bytes: value }); f.reader({ currentBytes: value, maxBytes: value });
    for (const name of ["mangaStorageBytes", "readerCacheBytes", "readerCacheLimit"]) assert.equal(f.els[name].textContent, "-", `${name}: invalid ${label} must not become zero bytes`);
  });
}

for (const value of [undefined, null, false, {}]) check(`unavailable payload ${String(value)}`, () => {
  const f = fixture(); f.manga(value); f.reader(value);
  for (const name of ["mangaStorageBytes", "readerCacheBytes", "readerCacheLimit"]) assert.equal(f.els[name].textContent, "-");
});
check("missing individual fields preserve known siblings", () => {
  const f = fixture(); f.reader({ maxBytes: 1024 });
  assert.equal(f.els.readerCacheBytes.textContent, "-"); assert.equal(f.els.readerCacheLimit.textContent, "1.00 KB");
  f.reader({ currentBytes: 1024 }); assert.equal(f.els.readerCacheBytes.textContent, "1.00 KB"); assert.equal(f.els.readerCacheLimit.textContent, "-");
});
check("manga availability hides byte counts from an unavailable root", () => {
  const f = fixture(); f.manga({ exists: false, bytes: 0 }); assert.equal(f.els.mangaStorageBytes.textContent, "-");
  f.manga({ bytes: 0 }); assert.equal(f.els.mangaStorageBytes.textContent, "-");
});
check("a successfully fetched cache can report zero before its directory exists", () => {
  const f = fixture(); f.reader({ exists: false, currentBytes: 0, maxBytes: 1024 });
  assert.equal(f.els.readerCacheBytes.textContent, "0 B"); assert.equal(f.els.readerCacheLimit.textContent, "1.00 KB");
});
check("unavailable redraw clears previous nonzero labels", () => {
  const f = fixture(); f.manga({ exists: true, bytes: 1024 }); f.reader({ currentBytes: 1024, maxBytes: 1024 ** 3 });
  f.manga(null); f.reader(null);
  for (const name of ["mangaStorageBytes", "readerCacheBytes", "readerCacheLimit"]) assert.equal(f.els[name].textContent, "-");
});
check("reader input focus and unrelated count fields keep their current behavior", () => {
  const f = fixture(); f.document.activeElement = f.els.readerCacheLimitInput;
  f.reader({ currentBytes: 0, maxBytes: 1024 ** 3, fileCount: 4, cleanupIntervalMs: 120000 });
  assert.equal(f.els.readerCacheLimitInput.value, "unchanged"); assert.equal(f.els.readerCacheFiles.textContent, "4");
  assert.equal(f.els.readerCacheCleanup.textContent, "2 分钟");
  f.manga({ exists: true, bytes: 0, comicCount: 2, chapterCount: 3, imageCount: 4, downloadedCount: 4 });
  assert.equal(f.els.mangaStorageComics.textContent, "2 本"); assert.equal(f.els.mangaStorageChapters.textContent, "3 话");
  assert.equal(f.els.mangaStorageImages.textContent, "4 张"); assert.equal(f.els.mangaStorageHealthStatus.textContent, "4 / 4 张 · 100%");
});
check("shared formatBytes still omits zero for compact cards", () => {
  assert.equal(formatBytes(0), ""); assert.equal(formatBytes(undefined), ""); assert.equal(formatBytes(1024), "1.00 KB");
});

const mutations = [
  ["manga original zero rendering", "manga", "formatStorageMetricBytes(storage.bytes)", "formatBytes(storage.bytes || 0)"],
  ["reader original zero rendering", "reader", "formatStorageMetricBytes(cache.currentBytes)", "formatBytes(currentBytes)"],
  ["limit original zero rendering", "limit", "formatStorageMetricBytes(cache.maxBytes)", "formatBytes(maxBytes)"]
];
for (const [name, target, current, previous] of mutations) check(`negative control: ${name}`, () => {
  const mutant = source.replace(current, previous); assert.notEqual(mutant, source, "negative control must alter the actual display path");
  assert.throws(() => assertKnownZero(mutant, target), /known .* must show 0 B/);
});
check("negative control: normalizing a missing field first fabricates a zero", () => {
  const mutant = source.replace("formatStorageMetricBytes(cache.currentBytes)", "formatStorageMetricBytes(currentBytes)");
  assert.notEqual(mutant, source); const f = fixture(mutant); f.reader({ maxBytes: 1024 });
  assert.throws(() => assert.equal(f.els.readerCacheBytes.textContent, "-"), /0 B/);
});
console.log(`Android storage metric verification passed (${cases} scenarios, including 4 negative controls; real shell functions and shared formatter, controlled DOM only).`);
