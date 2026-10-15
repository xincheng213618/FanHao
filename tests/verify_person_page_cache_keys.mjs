import assert from "node:assert/strict";
import fs from "node:fs";
import { createWorkQueryService } from "../src/modules/fanhao/server/works/work-query-service.js";
import { createPersonDetailService } from "../src/modules/fanhao/server/people/person-detail-service.js";

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
console.log(JSON.stringify({ ok: true, comparisons, cacheHitsPreserved: true, actualQueryAndClamp: true }));

function fixture(create) {
  const state = { user: "alice", visibility: "visible" };
  const person = { id: "person", name: "Synthetic person", works: Array.from({ length: 8 }, (_, index) => String(index + 1)) };
  const works = person.works.map((id, index) => ({ id, personId: person.id, title: `Title ${9 - Number(id)}`,
    modifiedAt: `2026-01-${id.padStart(2, "0")}`, infoSummary: { releaseDate: index % 2 ? "2025-01-01" : "2024-01-01" } }));
  const library = { scannedAt: "scan", worksById: new Map(works.map(work => [work.id, work])) };
  const query = createWorkQueryService({ library, actorMovieStamp: () => "actor", workQueryStamp: () => "works",
    peoplePayloadStamp: () => "people", userStateStamp: () => state.user, clampInteger, defaultWorkLimit: 4, maxWorkLimit: 16000,
    favoriteStateService: { isFavoriteWork: id => Number(id) % 2 === 0, publicFavoriteForWork: () => null },
    playbackProgressService: { getWorkProgress: () => null },
    publicWork: work => ({ id: work.id, user: state.user, visibility: state.visibility }),
    prewarmRemoteImagesForWorks: () => {},
    workClassificationService: { visibilityStamp: () => state.visibility, filterForRequest: works => works }
  });
  const target = { state, calls: 0 };
  const service = create({ library, maxActorAvatarBytes: 1024, peoplePayloadStamp: () => "people", workQueryStamp: () => "works",
    userStateStamp: () => state.user, mergedPersonRecord: value => value, resolveLibraryPersonByPublicId: id => id === person.id ? person : null,
    corePersonFallbackRecord: () => null, mergedActorMovieRows: () => [], coreMissingWorksForPerson: () => [],
    missingActorWorksForPerson: () => [], enrichLocalWorksWithActorMovieInfo: value => value, dedupeWorksForDisplay: value => value,
    workCodeKeySetForWorks: () => new Set(), storedWorkCodeKey: value => String(value || ""), publicPerson: value => ({ id: value.id }),
    peopleScopeService: { normalize: value => value || "main", personMatches: () => true, workMatches: () => true },
    workQueryService: { visibilityStamp: () => state.visibility, lightweightFacets: works => ({ all: works.length }),
      listFromWorksPayload(...args) { target.calls++; return query.listFromWorksPayload(...args); } }
  });
  target.read = params => service.detailPayload(person.id, new URL("http://fixture/person?" + new URLSearchParams(params)));
  return target;
}
