import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCodePrefixViews } from "../android-client/www/modules/fanhao/features/code-prefixes/prefix-views.js";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";

const source = "android-client/www/modules/fanhao/features/code-prefixes/prefix-views.js";
const root = new URL("../", import.meta.url);
const previous = execFileSync("git", ["show", `f110040d02b1eb579461248da9960e97370fa4d2:${source}`], { cwd: root, encoding: "utf8" })
  .replace(/from "(\.\.?\/[^\"]+)"/g, (_, path) => `from ${JSON.stringify(new URL(path, new URL(source, root)).href)}`);
const { createCodePrefixViews: previousViews } = await import(`data:text/javascript;base64,${Buffer.from(previous).toString("base64")}`);
const size = 1200;
const base = "https://synthetic.invalid";

async function fixture(factory) {
  const document = globalThis.document = createNavigationFixtureDocument();
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  const metrics = { created: 0, prefixReads: 0, makerReads: 0 };
  const makeElement = document.createElement;
  document.createElement = tag => {
    const node = makeElement(tag);
    Object.defineProperty(node, "isConnected", { get: () => document.body.contains(node) });
    metrics.created++;
    return node;
  };
  const viewContent = document.createElement("main");
  document.body.append(viewContent);
  const prefixes = Array.from({ length: size }, (_, index) => ({
    get prefix() { metrics.prefixReads++; return `PFX-${(index * 521) % size}`; },
    localCount: (index * 23) % 91,
    get maker() { metrics.makerReads++; return { name: `厂商 ${index % 11}` }; },
    makers: [{ name: index % 4 === 0 ? "共享别名" : "其他别名" }]
  }));
  const navigate = [];
  const warm = [];
  const views = factory({
    els: { viewContent, viewKicker: {}, viewTitle: {}, viewMeta: {} },
    getActiveUrl: () => base,
    setActiveBottom: () => {},
    getWorksLimit: () => 48,
    workListState: { getRequestState: () => ({ filter: "all", sort: "updated" }) },
    showView: (...args) => navigate.push(args),
    renderMessage: text => assert.fail(text),
    pageDataService: {
      async load(url, path) {
        assert.equal(url, base);
        assert.equal(path, "/api/code-prefixes?sort=count");
        return { data: { prefixes, mappedCount: size, localWorkCount: 54000 } };
      },
      warm: (...args) => warm.push(args)
    }
  });
  await views.renderIndex();
  const cards = () => viewContent.querySelectorAll(".code-prefix-mobile-card");
  const more = () => viewContent.querySelector(".code-prefix-mobile-more");
  function query(value) {
    const input = viewContent.querySelector("input");
    input.value = value;
    input.dispatchEvent({ type: "input" });
  }
  function snapshot() {
    return { cards: cards().map(node => node.textContent), more: more()?.textContent ?? "",
      summary: viewContent.querySelector(".code-prefix-mobile-summary").innerHTML,
      message: viewContent.querySelector(".message-box")?.textContent ?? "" };
  }
  return { cards, more, query, snapshot, metrics, navigate, warm, viewContent };
}

async function compare(factory, isCurrent) {
  const view = await fixture(factory);
  const states = [view.snapshot()];
  for (let page = 1; page < 15; page++) view.more().click();
  assert.equal(view.cards().length, 960);
  const originalCards = view.cards();
  const control = view.more();
  const before = { ...view.metrics };
  const start = performance.now();
  control.click();
  const duration = performance.now() - start;
  const cost = Object.fromEntries(Object.entries(view.metrics).map(([key, value]) => [key, value - before[key]]));
  const expandedCards = view.cards();
  assert.equal(expandedCards.length, 1024);
  if (isCurrent) {
    assert.equal(view.more(), control);
    assert(originalCards.every((card, index) => card === expandedCards[index]));
  }
  states.push(view.snapshot());
  while (view.more()) view.more().click();
  assert.equal(view.cards().length, size);
  states.push(view.snapshot());
  view.query(" 共享别名 ");
  const filtered = view.snapshot();
  if (isCurrent) {
    control.click();
    assert.deepEqual(view.snapshot(), filtered, "retired More cannot alter the active query page");
  }
  view.more().click();
  states.push(view.snapshot());
  view.viewContent.querySelector(".code-prefix-mobile-sort").children[1].click();
  view.more().click();
  states.push(view.snapshot());
  const card = view.cards()[80];
  const prefix = card.querySelector("strong").textContent;
  card.dispatchEvent({ type: "focus" });
  card.click();
  assert.equal(view.warm[0][1][0].split("?")[0], `/api/code-prefixes/${prefix}`);
  assert.deepEqual(view.navigate, [["codePrefixDetail", { prefix }, { push: true }]]);
  view.query("缺失厂商");
  states.push(view.snapshot());
  return { states, duration, cost };
}

const before = [];
const after = [];
for (let round = 0; round < 5; round++) {
  const legacy = await compare(previousViews, false);
  const current = await compare(createCodePrefixViews, true);
  assert.deepEqual(current.states, legacy.states);
  assert.equal(current.cost.created, 64 * 4, "More must construct only the new cards and their contents");
  assert.equal(current.cost.prefixReads, 64, "More must not re-sort the catalog");
  assert.equal(current.cost.makerReads, 64, "More must not reread existing card makers");
  before.push(legacy);
  after.push(current);
}
const median = runs => runs.map(run => run.duration).sort((a, b) => a - b)[2].toFixed(2);
console.log(`Android code prefixes (960→1024 of ${size}): elements ${before[0].cost.created}→${after[0].cost.created}; prefix reads ${before[0].cost.prefixReads}→${after[0].cost.prefixReads}; median ${median(before)}→${median(after)} ms.`);
