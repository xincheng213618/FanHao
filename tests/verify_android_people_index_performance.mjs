import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPeopleViews } from "../android-client/www/modules/fanhao/people-views.js";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";

const sourcePath = "android-client/www/modules/fanhao/people-views.js";
const root = new URL("../", import.meta.url);
const sourceUrl = new URL(sourcePath, root);
const previous = execFileSync("git", ["show", `f110040d02b1eb579461248da9960e97370fa4d2:${sourcePath}`], {
  cwd: root, encoding: "utf8"
}).replace(/from "(\.\.?\/[^\"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, sourceUrl).href)}`);
const { createPeopleViews: createPreviousViews } = await import(`data:text/javascript;base64,${Buffer.from(previous).toString("base64")}`);
const size = 10000;
const filters = ["recommended", "female", "male", "all"];
const sorts = ["smart", "works", "sources", "name"];

function makePeople(metrics) {
  return Array.from({ length: size }, (_, index) => {
    const name = `${["藤原", "田中", "林", "Taylor", "Jordan"][index % 5]} ${(index * 4099) % 391}`;
    const profile = {
      displayName: index % 31 === 0 ? "[collection]" : index % 3 === 0 ? `${name} Alias` : "",
      gender: index % 4 === 0 ? "male" : index % 7 === 0 ? undefined : "female",
      avatarUrl: index % 4 === 1 ? `/portrait/${index}.jpg` : ""
    };
    const avatarImage = index % 11 === 0 ? { source: "work_cover" } : null;
    return {
      id: `person-${index}`,
      name: index % 79 === 0 ? "unknownactor" : name,
      isWestern: index % 5 === 0,
      workCount: index % 17,
      sourceCount: index % 7,
      avatarUrl: index % 9 === 0 ? `/media/person/${index}/cover` : index % 3 === 0 ? `/avatar/${index}.jpg` : "",
      get avatarImage() { metrics.portraitReads++; return avatarImage; },
      get actorProfile() { metrics.profileReads++; return profile; }
    };
  });
}

async function render(factory, filter, sort, scope = "main", checkContinuation = false) {
  const document = globalThis.document = createNavigationFixtureDocument();
  const storage = new Map([["fanhao.android.peopleSort", sort], ["fanhao.android.peopleFilter", filter]]);
  globalThis.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  globalThis.IntersectionObserver = class { observe() {} disconnect() {} };
  const viewContent = document.createElement("main");
  document.body.append(viewContent);
  const els = { viewContent, viewKicker: {}, viewTitle: {}, viewMeta: {} };
  const metrics = { profileReads: 0, portraitReads: 0 };
  const people = makePeople(metrics);
  const selection = [];
  let limit = 64;
  const views = factory({
    els,
    getActiveUrl: () => "https://synthetic.invalid",
    getLibrary: () => ({ people }),
    getPeopleLimit: () => limit,
    increasePeopleLimit: amount => { limit += amount; },
    pageDataService: { async load(_url, path) {
      assert.equal(path, "/api/library?scope=western");
      return { data: { people } };
    } },
    setActiveBottom: () => {},
    showView: (...args) => selection.push(args),
    createLoadMoreButton: (text, handler) => {
      const button = document.createElement("button");
      button.className = "fixture-more";
      button.textContent = text;
      button.addEventListener("click", handler);
      return button;
    }
  });
  const start = performance.now();
  await views.renderPeopleIndex(scope);
  const duration = performance.now() - start;
  const reads = { ...metrics };
  const grid = viewContent.querySelector(".people-grid");
  const initialCards = [...grid.children];
  if (checkContinuation) {
    viewContent.querySelector(".fixture-more").click();
    assert.equal(grid.children.length, 128);
    assert(initialCards.every((card, index) => card === grid.children[index]), "pagination must retain the existing cards");
    if (scope === "main") {
      await views.renderPeopleIndex();
      assert.equal(viewContent.querySelector(".people-grid"), grid, "restoring the same view must reuse the existing grid");
    }
  }
  const cards = grid.children.map(card => {
    card.click();
    return [card.className, card.textContent];
  });
  return {
    reads, duration,
    snapshot: {
      title: els.viewTitle.textContent,
      meta: els.viewMeta.textContent,
      className: grid.className,
      filters: (viewContent.querySelector(".people-category-strip")?.children || []).map(button => [button.textContent, button.getAttribute("aria-pressed")]),
      cards,
      selection
    }
  };
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const filter of [...filters, "western"]) {
  for (const sort of sorts) {
    const scope = filter === "western" ? "western" : "main";
    const before = await render(createPreviousViews, filter, sort, scope, true);
    const after = await render(createPeopleViews, filter, sort, scope, true);
    assert.deepEqual(after.snapshot, before.snapshot, `${filter}/${sort} must preserve visible ordering, counts and navigation`);
    if (filter !== "all" && !(filter === "recommended" && sort === "smart")) continue;
    const previousTimes = [];
    const currentTimes = [];
    for (let round = 0; round < 5; round++) {
      previousTimes.push((await render(createPreviousViews, filter, sort)).duration);
      currentTimes.push((await render(createPeopleViews, filter, sort)).duration);
    }
    assert(after.reads.profileReads < before.reads.profileReads / 2, `${sort} must at least halve actor profile reads`);
    assert(after.reads.portraitReads < before.reads.portraitReads / 2, `${sort} must at least halve portrait reads`);
    console.log(`${filter}/${sort}: profile ${before.reads.profileReads} -> ${after.reads.profileReads}; portrait ${before.reads.portraitReads} -> ${after.reads.portraitReads}; median ${median(previousTimes).toFixed(1)} -> ${median(currentTimes).toFixed(1)} ms`);
  }
}
console.log(`Android people index: ${size} synthetic people, 20 filter/sort comparisons against the previous renderer.`);
