import assert from "node:assert/strict";
import fs from "node:fs";
import { tvSeriesCardNavigation } from "../android-client/www/platform/content-index/channel-views.js?verify-media-series=1";
import { CLIENT_VERSION } from "../android-client/www/js/config.js";

const legacySeries = { id: "legacy-key", type: "tvSeries", category: "华语剧" };
const groupedSeries = { id: "trusted-key", seriesKey: "trusted-series", type: "tvSeriesWork", category: "华语剧" };

assert.deepEqual(tvSeriesCardNavigation("tv", legacySeries), {
  tvView: "episodes",
  seriesKey: "legacy-key",
  category: "华语剧",
  query: "",
  sort: "title"
});
assert.deepEqual(tvSeriesCardNavigation("tv", groupedSeries), {
  tvView: "episodes",
  seriesKey: "trusted-series",
  category: "华语剧",
  query: "",
  sort: "title"
});
assert.deepEqual(tvSeriesCardNavigation("media", groupedSeries), {
  tvView: "episodes",
  seriesKey: "trusted-series",
  category: "华语剧",
  query: "",
  sort: "title",
  mode: "media"
});
assert.equal(tvSeriesCardNavigation("tv", { id: "episode", type: "galleryMedia" }), null);
assert.equal(tvSeriesCardNavigation("movie", groupedSeries), null);

for (const moduleName of ["media", "photos"]) {
  const source = fs.readFileSync(new URL(`../android-client/www/modules/${moduleName}/android-module.js`, import.meta.url), "utf8");
  assert(
    source.includes(`../../platform/content-index/channel-views.js?v=${CLIENT_VERSION}`),
    `${moduleName} must cache-bust the shared channel views with CLIENT_VERSION`
  );
}

console.log("media-channel-clients: ok");
