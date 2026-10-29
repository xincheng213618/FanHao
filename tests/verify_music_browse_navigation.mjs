import assert from "node:assert/strict";
import fs from "node:fs";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual sidebar/catalog controls, request parameters, routes and visible
// songs in private Chromium. Synthetic APIs and controlled Audio only.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "browse navigation " });
if (!caseOption) {
  const readSource = name => fs.readFileSync(new URL(`../public/modules/music/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const actions = readSource("actions.js"), page = readSource("music-page.js");
  for (const control of [
    { name: "collection navigation query reset", source: actions, path: "actions.js", casePattern: "browse navigation all songs leaves an unrelated empty search ignore-abort", marker: 'music().playlistDialogName = "";\n    music().query = "";', replacement: 'music().playlistDialogName = "";', failure: /context navigation must clear the previous search before requesting its new collection/ },
    { name: "sidebar artist query reset", source: page, path: "music-page.js", casePattern: "browse navigation artist leaves an unrelated empty search ignore-abort", marker: 'artistList.append(filterButton(artist.id, artist.name, artist.trackCount, state.music.mode === "library" && state.music.artistId === artist.id, () => {\n        state.music.mode = "library";\n        state.music.query = "";', replacement: 'artistList.append(filterButton(artist.id, artist.name, artist.trackCount, state.music.mode === "library" && state.music.artistId === artist.id, () => {\n        state.music.mode = "library";', failure: /context navigation must clear the previous search before requesting its new collection/ },
    { name: "sidebar album query reset", source: page, path: "music-page.js", casePattern: "browse navigation album leaves an unrelated empty search ignore-abort", marker: 'state.music.libraryDrawerOpen = false;\n        state.music.mode = "library";\n        state.music.query = "";', replacement: 'state.music.libraryDrawerOpen = false;\n        state.music.mode = "library";', failure: /context navigation must clear the previous search before requesting its new collection/ },
    { name: "genre navigation query reset", source: actions, path: "actions.js", casePattern: "browse navigation genre leaves an unrelated empty search ignore-abort", marker: 'music().albumId = "all";\n    music().query = "";\n    music().genre = String', replacement: 'music().albumId = "all";\n    music().genre = String', failure: /context navigation must clear the previous search before requesting its new collection/ }
  ]) {
    assert.equal(control.source.split(control.marker).length - 1, 1, `negative must modify its current owning behavior: ${control.name}`);
    await assert.rejects(() => runMusicReaderFixture({ casePattern: control.casePattern, sourceOverrides: { [`/modules/music/${control.path}`]: control.source.replace(control.marker, control.replacement) } }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
