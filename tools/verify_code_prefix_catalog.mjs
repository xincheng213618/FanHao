import assert from "node:assert/strict";
import { createCodePrefixService } from "../src/modules/fanhao/server/catalog/code-prefix-service.js";
import {
  codePrefixMatches,
  normalizeRequestedCodePrefix,
  workCodePrefix
} from "../src/modules/fanhao/server/works/work-code-prefix.js";

for (const [value, expected] of [
  ["IPX-735", "IPX"],
  ["FC2-PPV-3253595", "FC2-PPV"],
  ["FC2-1064996", "FC2"],
  ["300MIUM-123", "300MIUM"],
  ["[A].START-585 标题", "START"],
  ["IPX123", "IPX"]
]) {
  assert.equal(workCodePrefix(value), expected, `prefix parser should normalize ${value}`);
}
assert.equal(normalizeRequestedCodePrefix("fc2_ppv"), "FC2-PPV");
assert.equal(codePrefixMatches({ infoSummary: { code: "FC2-PPV-123" } }, "FC2", true), true);
assert.equal(codePrefixMatches({ infoSummary: { code: "IPXVR-123" } }, "IPX", false), false);

const localWorks = [
  localWork("1", "IPX-001"),
  localWork("2", "IPX-002"),
  localWork("3", "SONE-001"),
  localWork("4", "FC2-PPV-100001")
];
const makerRows = [
  { work_id: "1", maker_id: "10", maker_name: "IDEA POCKET" },
  { work_id: "2", maker_id: "10", maker_name: "IDEA POCKET" },
  { work_id: "3", maker_id: "11", maker_name: "S1 NO.1 STYLE" }
];
const missingByPrefix = {
  IPX: [
    missingWork("101", "IPX-003"),
    missingWork("102", "IPXVR-001")
  ],
  FC2: [missingWork("103", "FC2-PPV-100002")]
};

const service = createCodePrefixService({
  clampInteger(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
  },
  dedupeWorksForDisplay(works) {
    return [...new Map(works.map((work) => [String(work.id), work])).values()];
  },
  defaultWorkLimit: 48,
  fastMissingCodeSearch(prefix) {
    return missingByPrefix[prefix] || [];
  },
  filterWorkList(works, filter) {
    if (filter === "localOnly") return works.filter((work) => !work.missingLocal);
    if (filter === "missingLocal") return works.filter((work) => work.missingLocal);
    return works;
  },
  getCoreDb() {
    return { prepare: () => ({ all: () => makerRows }) };
  },
  getLibrary() {
    return {
      scannedAt: "test",
      worksById: new Map(localWorks.map((work) => [work.id, work]))
    };
  },
  getStamp: () => "makers-v1",
  hydrateMissingSearchWorks() {},
  maxWorkLimit: 1000,
  pagedWorksPayload(works, url, extra) {
    const limit = Number(url.searchParams.get("limit") || 48);
    const offset = Number(url.searchParams.get("offset") || 0);
    return {
      ...extra,
      count: works.slice(offset, offset + limit).length,
      total: works.length,
      limit,
      offset,
      sort: url.searchParams.get("sort") || "releaseDesc",
      works: works.slice(offset, offset + limit)
    };
  },
  sortWorkList(works) {
    return [...works];
  },
  userStateStamp: () => "user-v1",
  workClassificationService: {
    filterForRequest(works, url, filter) {
      const includeMissing = url.searchParams.get("includeMissingLocal") !== "0";
      if (includeMissing || filter === "missingLocal") return works;
      return works.filter((work) => !work.missingLocal);
    },
    visibilityStamp: () => "visibility-v1"
  },
  workFacets(works) {
    return {
      all: works.length,
      localOnly: works.filter((work) => !work.missingLocal).length,
      missingLocal: works.filter((work) => work.missingLocal).length
    };
  }
});

const summaries = service.summaries(new URL("http://fanhao.local/api/code-prefixes?sort=count"));
const ipx = summaries.prefixes.find((item) => item.prefix === "IPX");
const fc2 = summaries.prefixes.find((item) => item.prefix === "FC2-PPV");
assert.equal(ipx.localCount, 2, "prefix counts must use local works only");
assert.equal(ipx.maker.name, "IDEA POCKET", "prefix rows must expose their dominant maker");
assert.equal(fc2.maker.name, "FC2 内容市场", "FC2 prefixes must be represented as a platform");
assert.equal(fc2.maker.kind, "platform");

const ipxWithMissing = service.detailPayload(
  "IPX",
  new URL("http://fanhao.local/api/code-prefixes/IPX?limit=48&includeMissingLocal=1")
);
assert.equal(ipxWithMissing.total, 3, "exact prefixes must include matching missing works");
assert.equal(ipxWithMissing.codePrefix.localCount, 2);
assert.equal(ipxWithMissing.codePrefix.missingCount, 1);

const ipxLocalOnly = service.detailPayload(
  "IPX",
  new URL("http://fanhao.local/api/code-prefixes/IPX?limit=48&includeMissingLocal=0")
);
assert.equal(ipxLocalOnly.total, 2, "the missing-local toggle must preserve the local prefix count");

const fc2Family = service.detailPayload(
  "FC2",
  new URL("http://fanhao.local/api/code-prefixes/FC2?family=1&limit=48&includeMissingLocal=1")
);
assert.equal(fc2Family.total, 2, "the FC2 family shortcut must include every FC2 sub-prefix");
assert.equal(fc2Family.codePrefix.maker.kind, "platform");

console.log("code-prefix-catalog: ok");

function localWork(id, code) {
  return {
    id,
    title: code,
    directoryName: code,
    infoSummary: { code },
    missingLocal: false,
    videoCount: 1,
    playableCount: 1
  };
}

function missingWork(id, code) {
  return {
    id,
    title: code,
    directoryName: code,
    infoSummary: { code },
    missingLocal: true,
    videoCount: 0,
    playableCount: 0
  };
}
