import assert from "node:assert/strict";
import fs from "node:fs";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createPersonDetailService } from "../src/modules/fanhao/server/people/person-detail-service.js";
import { createWorkClassificationService } from "../src/modules/fanhao/server/works/work-classification-service.js";

// Real person/query modules with synthetic library entries; no server or database.
assert.ok(process.argv.slice(2).every(value => value === "--legacy-key"));
let createPerson = createPersonDetailService;
if (process.argv.includes("--legacy-key")) {
  const url = new URL("../src/modules/fanhao/server/people/person-detail-service.js", import.meta.url);
  const text = fs.readFileSync(url, "utf8");
  assert.equal(text.split("page: JSON.stringify(parts)").length, 2);
  const previous = text.replace("page: JSON.stringify(parts)", 'page: parts.join(":")')
    .replace(/from "(\.\.?\/[^"]+)"/gu, (_, relative) => `from "${new URL(relative, url).href}"`);
  createPerson = (await import(`data:text/javascript;base64,${Buffer.from(previous).toString("base64")}`)).createPersonDetailService;
}
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const clampSource = server.slice(server.indexOf("function clampInteger("), server.indexOf("function allWorks("));
assert.ok(clampSource.includes("Number.isFinite"));
const clampInteger = new Function(`${clampSource}\nreturn clampInteger;`)();
let comparisons = 0;
for (const [left, right] of [
  [{ limit: "1:2", offset: "0" }, { limit: "1", offset: "2:0" }],
  [{ sort: "title:1", limit: "2" }, { sort: "title", limit: "1:2" }],
  [{ filter: "favorite:2024", year: "all" }, { filter: "favorite", year: "2024", includeMissingLocal: "all:" }],
]) {
  for (const [first, second] of [[left, right], [right, left]]) {
    const warm = fixture(createPerson), cold = fixture(createPerson);
    warm.read(first);
    const expected = cold.read(second), actual = warm.read(second);
    assert.deepEqual(actual, expected, "a warmed parameter combination must match a cold request"); comparisons++;
    const calls = warm.calls;
    assert.deepEqual(warm.read(second), expected);
    assert.equal(warm.calls, calls, "an identical request still reuses the prepared page");
  }
}
// Dependencies are independent key fields, even when their stamps contain colons.
for (const reverse of [false, true]) {
  const warm = fixture(createPerson), cold = fixture(createPerson);
  const versions = [{ user: "alice:session", visibility: "visible" }, { user: "alice", visibility: "session:visible" }];
  if (reverse) versions.reverse();
  Object.assign(warm.state, versions[0]); warm.read({ limit: "2" });
  Object.assign(warm.state, versions[1]); Object.assign(cold.state, versions[1]);
  assert.deepEqual(warm.read({ limit: "2" }), cold.read({ limit: "2" }), "account and visibility versions must not alias"); comparisons++;
}
const boundaries = fixture(createPerson);
for (const params of [{}, { limit: "0" }, { limit: "-1" }, { limit: "2.8", offset: "1.9" }, { limit: "bad", offset: "bad" }, { offset: "999" }, { limit: "16001" }, { year: "2024" }]) {
  assert.deepEqual(boundaries.read(params), fixture(createPerson).read(params)); comparisons++;
}
const scoped = fixture(createPerson, { missing: true });
const allPersonTraits = scoped.read({ traitScope: "person" }).traitFacets;
assert.equal(allPersonTraits.total, 9);
const narrow = { year: "2024", filter: "tag:Even" };
const legacy = scoped.read(narrow);
assert.equal(legacy.traitFacets.total, 0);
const filteredPerson = scoped.read({ ...narrow, traitScope: "person" });
assert.equal(filteredPerson.total, 0);
assert.deepEqual(filteredPerson.traitFacets, allPersonTraits, "an empty intersection preserves every person facet");
assert.deepEqual(scoped.read({ traitScope: "person", filter: "tag:Odd", limit: "1", offset: "2" }).traitFacets, allPersonTraits);
const localTraits = scoped.read({ ...narrow, traitScope: "person", includeMissingLocal: "0" }).traitFacets;
assert.equal(localTraits.total, 8);
assert(!localTraits.tags.some(({ name }) => name === "Missing"));
assert.deepEqual(scoped.read({ ...narrow, traitScope: "person" }).traitFacets, allPersonTraits, "visibility keys cannot alias");
const titleSearch = { q: "midnight", limit: "1", sort: "title", traitScope: "person" };
const firstTitle = scoped.read(titleSearch);
const nextTitle = scoped.read({ ...titleSearch, offset: "1" });
assert.equal(firstTitle.query, "midnight");
assert.equal(firstTitle.total, 2, "title search filters the complete person source before applying the page limit");
assert.deepEqual([...firstTitle.works, ...nextTitle.works].map(work => work.id), ["8", "1"]);
assert.deepEqual(nextTitle.traitFacets, allPersonTraits);
assert.deepEqual(scoped.read({ ...titleSearch, filter: "tag:Odd" }).works.map(work => work.id), ["1"]);
assert.deepEqual(scoped.read({ ...titleSearch, q: "ｆｘ００１" }).works.map(work => work.id), ["1"]);
assert.deepEqual(scoped.read({ ...titleSearch, q: "cp105" }).works.map(work => work.id), ["7"]);
assert.equal(scoped.read({ ...titleSearch, q: "missing" }).total, 1);
assert.equal(scoped.read({ ...titleSearch, q: "missing", includeMissingLocal: "0" }).total, 0);
assert.equal(scoped.read({ ...titleSearch, q: "different" }).total, 0);
assert.equal(scoped.read({ ...titleSearch, q: "" }).total, 9);
const searchCalls = scoped.calls;
assert.deepEqual(scoped.read(titleSearch), firstTitle);
assert.equal(scoped.calls, searchCalls, "repeated search requests keep the result for their own keyword");
console.log(JSON.stringify({ ok: true, comparisons, cacheHitsPreserved: true, actualQueryAndClamp: true, scopedTitleAndCodeSearch: true }));

function fixture(create, { missing = false } = {}) {
  const state = { user: "alice", visibility: "visible" };
  const person = { id: "person", name: "Synthetic person", works: Array.from({ length: 8 }, (_, index) => String(index + 1)) };
  const works = person.works.map((id, index) => ({ id, personId: person.id, title: `Title ${9 - Number(id)}`,
    modifiedAt: `2026-01-${id.padStart(2, "0")}`, infoSummary: { releaseDate: index % 2 ? "2025-01-01" : "2024-01-01",
      ...(id === "1" || id === "8" ? { title: "Fixture midnight", code: `FX-00${id}` } : {}),
      tags: [index % 2 ? "Even" : "Odd"] } }));
  const library = { scannedAt: "scan", worksById: new Map(works.map(work => [work.id, work])) };
  const query = createWorkQueryService({ library, actorMovieStamp: () => "actor", workQueryStamp: () => "works",
    peoplePayloadStamp: () => "people", userStateStamp: () => state.user, clampInteger, defaultWorkLimit: 4, maxWorkLimit: 16000,
    favoriteStateService: { isFavoriteWork: id => Number(id) % 2 === 0, publicFavoriteForWork: () => null },
    playbackProgressService: { getWorkProgress: () => null },
    workInfoFacetRow: id => id === "7" ? { code: "CP-105" } : null,
    publicWork: work => ({ id: work.id, user: state.user, visibility: state.visibility }),
    prewarmRemoteImagesForWorks: () => {},
    workClassificationService: { ...createWorkClassificationService({}), visibilityStamp: () => state.visibility }
  });
  const target = { state, calls: 0 };
  const service = create({ library, maxActorAvatarBytes: 1024, peoplePayloadStamp: () => "people", workQueryStamp: () => "works",
    userStateStamp: () => state.user, mergedPersonRecord: value => value, resolveLibraryPersonByPublicId: id => id === person.id ? person : null,
    corePersonFallbackRecord: () => null, mergedActorMovieRows: () => [], coreMissingWorksForPerson: () => missing
      ? [{ id: "missing", title: "Missing fixture", missingLocal: true, infoSummary: { tags: ["Missing"] } }] : [],
    missingActorWorksForPerson: () => [], enrichLocalWorksWithActorMovieInfo: value => value, dedupeWorksForDisplay: value => value,
    workCodeKeySetForWorks: () => new Set(), storedWorkCodeKey: value => String(value || ""), publicPerson: value => ({ id: value.id }),
    peopleScopeService: { normalize: value => value || "main", personMatches: () => true, workMatches: () => true },
    workQueryService: { visibilityStamp: () => state.visibility, lightweightFacets: works => ({ all: works.length }),
      listFromWorksPayload(...args) { target.calls++; return query.listFromWorksPayload(...args); } }
  });
  target.read = params => service.detailPayload(person.id, new URL("http://fixture/person?" + new URLSearchParams(params)));
  return target;
}
