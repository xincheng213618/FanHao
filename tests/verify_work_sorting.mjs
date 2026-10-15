import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createWorkSorter } from "../src/modules/fanhao/server/works/work-sorter.js";

const works = [
  { id: "a", title: "Film 10", modifiedAt: "2024", videoCount: 2, videos: [{ size: 10 }, { size: 20 }], releaseDate: "2020", rating: 4, ratingCount: 10, duration: 90, code: "A-10", updatedAt: "2026-05-01" },
  { id: "b", title: "Film 2", modifiedAt: "2025", videoCount: 1, videos: [{ size: 10 }], releaseDate: "2022", rating: 5, ratingCount: 5, duration: 60, code: "A-2", updatedAt: "2026-05-02" },
  { id: "c", title: "Film 1", modifiedAt: "2023", videoCount: 3, videos: [], releaseDate: "", rating: null, ratingCount: 20, duration: 0, code: "A-1" },
  { id: "d", title: "Film 20", modifiedAt: "2024", videoCount: 2, videos: [{ size: 40 }], releaseDate: "2020", rating: 4, ratingCount: 10, duration: 120, code: "A-20" }
];
const snapshot = JSON.stringify(works);
let titleReads = 0;
let metadataOptions;
const sorter = createWorkSorter({
  metadataForWork: (work, options) => { metadataOptions = options; return work; },
  progressForWork: (work) => work,
  displayWorkTitle: (title) => { titleReads += 1; return title; }
});
for (const [sort, expected] of Object.entries({
  title: "cbad", updated: "badc", unknown: "badc", videos: "cadb", progress: "bacd",
  releaseDesc: "badc", releaseAsc: "adbc", ratingDesc: "badc", ratingAsc: "adbc",
  ratingCountDesc: "cadb", popularityDesc: "adbc",
  size: "dabc", sizeDesc: "dabc", sizeAsc: "cbad",
  duration: "dabc", durationDesc: "dabc", durationAsc: "cbad",
  codeAsc: "cbad", codeDesc: "dabc"
})) {
  assert.equal(sorter(works, sort).map((work) => work.id).join(""), expected, `ordering for ${sort}`);
}
assert.equal(JSON.stringify(works), snapshot, "sorting must not mutate the source or work records");
const options = { lightweightInfo: true };
sorter(works, "ratingDesc", options);
assert.equal(metadataOptions, options, "metadata consumers retain lightweight preparation semantics");
titleReads = 0;
const large = Array.from({ length: 10_000 }, (_, index) => ({
  id: index, title: `Film ${index}`, rating: (index * 7919) % 10_000, ratingCount: 1
}));
const samples = [];
for (let iteration = 0; iteration < 4; iteration += 1) {
  const start = performance.now();
  const sorted = sorter(large, "ratingDesc");
  if (iteration) samples.push(performance.now() - start);
  assert.equal(sorted[0].rating, 9999);
  assert.equal(sorted.at(-1).rating, 0);
}
assert.equal(titleReads, 0, "distinct primary ratings must never require title preparation/comparison");
titleReads = 0;
sorter(works, "title");
assert.ok(titleReads <= works.length, "display titles are prepared at most once per work");
console.log(`work-sorting: ok (19 orders, missing values/ties, immutable input, 10000 rows: ${samples.map((ms) => ms.toFixed(1)).join("/")}ms)`);
