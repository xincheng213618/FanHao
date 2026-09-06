import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { channelConfig, tvSeriesCardNavigation } from "../android-client/www/platform/content-index/channel-views.js";
import { formatBytes, formatDate, formatNumber } from "../android-client/www/js/format.js";
import { appFunction, createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";

// Actual presentation/signature and complete card method execute. Only the DOM,
// image loading and destination dispatch are doubles; no media/network/device.
const source = fs.readFileSync(new URL("../android-client/www/platform/content-index/channel-views.js", import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const tests = [];
const test = (name, run) => tests.push({ name, run });
function nested(text, name) {
  const start = text.indexOf(`  function ${name}(`), tail = text.slice(start), end = /^  \}/m.exec(tail);
  assert(start >= 0 && end, `Actual card dependency ${name}`); return tail.slice(0, end.index + 3);
}
function harness(input = source) {
  const document = createNavigationFixtureDocument(), calls = { covers: [], destinations: [] };
  const c = vm.createContext({ document, channelConfig, tvSeriesCardNavigation, formatBytes, formatDate, formatNumber,
    absoluteUrl: (base, path) => new URL(path, base).href, getActiveUrl: () => "https://synthetic.invalid/",
    loadChannelPreviewImage: (...args) => calls.covers.push(args),
    updateChannelParams: (...args) => calls.destinations.push(["channel", ...args]),
    showMediaDetail: (...args) => calls.destinations.push(["detail", ...args]),
    openInLibrary: (...args) => calls.destinations.push(["external", ...args])
  });
  const top = input.replace(/^export /gm, "");
  vm.runInContext([appFunction(top, "movieMetadataHasSeriesConflict"), appFunction(top, "normalizeMediaMetadataItem"),
    appFunction(top, "mediaCardPresentation"), appFunction(top, "channelDataSignature"),
    ...["mediaDetailModeForItem", "createChannelCard", "thumbFallbackText", "channelCardLabel", "channelCardTitle", "channelCardSubtitle", "channelFacts"].map(name => nested(input, name))].join("\n"), c);
  return { c, calls, card: (mode, item) => c.createChannelCard(mode, item, { index: 3 }), presentation: (mode, item) => plain(c.mediaCardPresentation(mode, item)) };
}
const SERIES_TITLE = "合成剧集";
for (const type of ["tvSeries", "tvSeriesWork"]) test(`${type} directory card has one title and in-library episode count`, input => {
  const h = harness(input), item = { id: "synthetic-series", type, title: `${SERIES_TITLE} (2024)`, year: 2024, chapterCount: 8, episodeCount: 12, category: SERIES_TITLE, tvSeries: { title: SERIES_TITLE, rating: 8.2 } };
  const p = h.presentation("tv", item); assert.equal(p.series, true); assert.equal(p.episode, false);
  assert.equal(p.title, SERIES_TITLE); assert.equal(p.meta, "2024 · 12 集在库");
  const card = h.card("tv", item);
  assert.equal(card.querySelectorAll("strong").length, 1); assert.equal(card.querySelector("strong").textContent, SERIES_TITLE);
  assert.equal(card.querySelectorAll(".channel-label,.channel-subtitle").length, 0, "Do not repeat directory title as old label and subtitle");
  assert.equal(card.querySelector(".media-card-meta").textContent, "2024 · 12 集在库");
  assert.equal(card.classList.contains("media-poster-card"), true);
  assert.equal(card.getAttribute("aria-label"), "合成剧集，2024 · 12 集在库，评分 8.2");
});
test("movie metadata title takes precedence and matching year suffix is removed once", input => {
  const h = harness(input), p = h.presentation("movie", { title: "technical.release.1080p", movieMetadata: { title: "合成电影（2023）", year: "2023", genres: ["科幻"], rating: "7.6" } });
  assert.deepEqual(p, { episode: false, series: false, title: "合成电影", meta: "2023 · 科幻", rating: "7.6" });
});
test("a title year is preserved without matching year metadata", input => {
  const h = harness(input);
  assert.equal(h.presentation("movie", { title: "合成电影 (1999)" }).title, "合成电影 (1999)");
  assert.equal(h.presentation("movie", { title: "合成电影 (1999)", year: 2024 }).title, "合成电影 (1999)");
  assert.equal(h.presentation("movie", { title: "合成电影 1999", year: 1999 }).title, "合成电影 1999");
});
test("localized movie captions remove only translated English tail and retain pure English titles and bare years", input => {
  const h = harness(input);
  for (const [title, expected] of [["合成 中文标题 Synthetic English Subtitle", "合成 中文标题"], ["Synthetic Prefix 合成 标题 English Tail", "Synthetic Prefix 合成 标题"],
    ["A Synthetic English Movie (1999)", "A Synthetic English Movie (1999)"], ["合成电影 (1999)", "合成电影 (1999)"]]) {
    const item = { id: "synthetic-movie", title: "unchanged.release.filename.mkv", movieMetadata: { title } }, before = structuredClone(item);
    assert.equal(h.presentation("movie", item).title, expected);
    assert.equal(h.card("movie", item).querySelector("strong").textContent, expected);
    assert.deepEqual(item, before, "Localized display must not mutate source metadata or filenames");
  }
  assert.equal(h.presentation("movie", { title: "合成电影 (1999)" }).title, "合成电影 (1999)");
});
test("Western card retains original filename label and file-summary DOM instead of poster presentation", input => {
  const h = harness(input), item = { id: "synthetic-western", title: "Synthetic Western File (1999) 1080p.mp4", category: "欧美分类", seriesName: "合成系列",
    ext: "mp4", size: 2048, updatedAt: "2026-08-01T00:00:00Z", movieMetadata: { title: "合成电影 English Subtitle", rating: 8.6 } }, before = structuredClone(item);
  const card = h.card("western", item);
  assert.equal(h.c.mediaCardPresentation("western", item), null);
  assert.equal(card.querySelector("strong").textContent, item.title);
  assert.equal(card.querySelector(".channel-label").textContent, "欧美分类 · 合成系列");
  assert.deepEqual(card.querySelector(".channel-facts").children.map(node => node.textContent), ["MP4", formatBytes(2048), formatDate(item.updatedAt)]);
  assert.equal(card.querySelector(".channel-thumb").parentNode, card);
  assert.equal(card.querySelector(".media-card-cover,.media-card-meta,.media-poster-rating"), null);
  assert.equal(card.classList.contains("media-poster-card"), false); assert.deepEqual(item, before);
});
test("unknown or invalid ratings never create zero NaN or misleading score badges", input => {
  const h = harness(input);
  for (const rating of [undefined, null, "", "unknown", NaN, Infinity, -1, 0, 11]) {
    const item = { id: "synthetic", title: "合成电影", rating }, p = h.presentation("movie", item), card = h.card("movie", item);
    assert.equal(p.rating, ""); assert.equal(card.querySelector(".media-poster-rating"), null);
    assert.equal(card.getAttribute("aria-label").includes("评分"), false);
  }
  assert.equal(h.presentation("movie", { rating: 10 }).rating, "10.0");
});
test("TV episode technical SxxExx title is display-only and original item remains unchanged", input => {
  const h = harness(input);
  for (const [filename, title] of [["Synthetic.Show.S01E002.2160p.WEB-DL.mkv", "第 2 集"], ["Synthetic.S02E03.x265.mkv", "第 2 季 · 第 3 集"]]) {
    const item = { id: "episode", title: filename, type: "tv", ext: "mkv", size: 2048, tvSeries: { title: "合成剧集", rating: 9.2 } }, before = structuredClone(item);
    const p = h.presentation("media", item), card = h.card("media", item);
    assert.equal(p.episode, true); assert.equal(p.series, false); assert.equal(p.title, title); assert.equal(p.rating, "");
    assert.equal(p.meta, `MKV · ${formatBytes(2048)}`); assert.equal(card.querySelector("strong").textContent, title);
    assert.equal(card.classList.contains("media-episode-card"), true); assert.deepEqual(item, before);
  }
});
test("photo manga and western do not enter media presentation", input => {
  const h = harness(input); for (const mode of ["photo", "manga", "western"]) assert.equal(h.c.mediaCardPresentation(mode, { title: "unchanged" }), null);
});
test("missing and malformed metadata uses safe fallback without NaN labels", input => {
  const h = harness(input);
  for (const metadata of [undefined, null, false, "not-an-object", [], { genres: [null, 42, "", "剧情"], rating: "unknown" }]) {
    const p = h.presentation("movie", { title: "合成电影", movieMetadata: metadata });
    assert.equal(p.title, "合成电影"); assert.equal(p.rating, ""); assert.equal(p.meta.includes("NaN"), false);
    assert.doesNotThrow(() => h.card("movie", { title: "合成电影", movieMetadata: metadata }));
  }
  assert.equal(h.presentation("movie", {}).title, "影片"); assert.equal(h.presentation("tv", {}).title, "剧集");
});
test("cover wrapper and accessible label survive preview-loader replacement", input => {
  const h = harness(input), item = { id: "poster", title: "合成电影", coverUrl: "/synthetic-cover.jpg", rating: 8.5, year: 2025 };
  const card = h.card("movie", item), frame = card.querySelector(".media-card-cover"), thumb = frame.querySelector(".channel-thumb");
  assert.equal(card.tagName, "BUTTON"); assert.equal(card.type, "button"); assert.equal(frame.getAttribute("aria-hidden"), "true");
  assert.equal(frame.parentNode, card); assert.equal(h.calls.covers.length, 1);
  assert.equal(h.calls.covers[0][0], thumb); assert.deepEqual(h.calls.covers[0].slice(1), ["https://synthetic.invalid/synthetic-cover.jpg", "movie", 3]);
  thumb.replaceChildren(h.c.document.createElement("img"));
  const badge = frame.querySelector(".media-poster-rating");
  assert(badge, "Preview replacement must not remove the rating badge");
  assert.equal(badge.textContent, "8.5", "Loader only owns thumb, not badge/container");
  assert.equal(card.querySelector("strong").textContent, "合成电影"); assert.equal(card.getAttribute("aria-label"), "合成电影，2025，评分 8.5");
});
test("actual directory and episode card handlers retain their distinct destinations", input => {
  const h = harness(input);
  h.card("tv", { id: "series", seriesKey: "series-key", type: "tvSeriesWork", title: "合成剧集", episodeCount: 4 }).click();
  assert.equal(h.calls.destinations[0][0], "channel"); assert.equal(h.calls.destinations[0][1].seriesKey, "series-key"); assert.equal(h.calls.destinations[0][2].push, true);
  h.card("media", { id: "episode", type: "tv", title: "Synthetic.S01E01.mkv" }).click();
  assert.deepEqual(h.calls.destinations[1], ["detail", "episode", "tv"]);
});
test("every newly displayed metadata field invalidates otherwise identical cache signature", input => {
  const h = harness(input), base = { total: 1, mode: "media", items: [{ id: "same-id", title: "same-title", updatedAt: "fixed" }] }, signature = h.c.channelDataSignature(base);
  for (const fields of [{ year: 2024 }, { rating: 8.1 }, { genres: ["科幻"] }, { movieMetadata: { title: "changed movie" } },
    { tvSeries: { title: "changed series", year: 2023 } }, { episodeCount: 18 }, { mediaKind: "tv" }, { category: "剧情" }, { ext: "mkv" }]) {
    assert.notEqual(h.c.channelDataSignature({ ...base, items: [{ ...base.items[0], ...fields }] }), signature, `Visible field missed by signature: ${Object.keys(fields)[0]}`);
  }
});
test("cache signature is stable for equal cloned data and changes on nested metadata update", input => {
  const h = harness(input), data = { mode: "tv", items: [{ id: "series", tvSeries: { title: "合成剧集", rating: 7.5 }, chapterCount: 2 }] }, before = structuredClone(data);
  assert.equal(h.c.channelDataSignature(data), h.c.channelDataSignature(before));
  const changed = structuredClone(data); changed.items[0].tvSeries.rating = 8.2;
  assert.notEqual(h.c.channelDataSignature(changed), h.c.channelDataSignature(data)); assert.deepEqual(data, before);
});

const controls = [
  { name: "tvSeriesWork mistaken for an episode", target: "tvSeriesWork", mutate: text => {
    const old = appFunction(text.replace(/^export /gm, ""), "mediaCardPresentation");
    return text.replace(old, () => old.replace('["tvSeries", "tvSeriesWork"]', '["tvSeries"]'));
  } },
  { name: "metadata update does not invalidate cached cards", target: "every newly", mutate: text => text.replace(/^      item\.movieMetadata \?\? null,\r?\n/m, "") },
  { name: "cover badge belongs to replaceable thumbnail", target: "cover wrapper", mutate: text => text.replace("frame.append(rating);", "thumb.append(rating);") }
];
let failures = 0, passed = 0, rejected = 0;
for (const item of tests) { try { item.run(source); passed++; console.log(`PASS ${item.name}`); } catch (error) { failures++; console.error(`FAIL ${item.name}\n${error.stack}`); } }
if (!failures) for (const control of controls) {
  try {
    const changed = control.mutate(source); assert.notEqual(changed, source, `No-op control ${control.name}`);
    let failure; try { tests.find(item => item.name.startsWith(control.target)).run(changed); } catch (error) { failure = error; }
    assert(failure instanceof assert.AssertionError, `Safety assertion required, not unrelated runtime failure: ${control.name}: ${failure?.stack || "unexpected pass"}`);
    rejected++; console.log(`REJECT ${control.name}`);
  } catch (error) { failures++; console.error(`FAIL control ${control.name}\n${error.stack}`); }
}
console.log(`Media presentation: ${passed}/${tests.length} scenarios; ${rejected}/${controls.length} safety controls; ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
