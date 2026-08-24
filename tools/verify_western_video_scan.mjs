import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalLibraryScanService } from "../src/modules/fanhao/server/library/local-library-scan-service.js";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-western-video-scan-"));
const westernRoot = path.join(fixtureRoot, "R");
const personDir = path.join(westernRoot, "Anjelica");
const collectionDir = path.join(personDir, "Collection");

try {
  fs.mkdirSync(collectionDir, { recursive: true });
  fs.writeFileSync(path.join(collectionDir, "alpha.mp4"), "video-a");
  fs.writeFileSync(path.join(collectionDir, "alpha.jpg"), "image-a");
  fs.writeFileSync(path.join(collectionDir, "beta.wmv"), "video-b");
  fs.writeFileSync(path.join(collectionDir, "folder.jpg"), "shared-image");

  const createService = (singleVideoRoots, libraryRoots = [westernRoot], excludedRoots = []) => createLocalLibraryScanService({
    compareNaturalName: (left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }),
    compareNaturalTitle: (left, right) => left.title.localeCompare(right.title, undefined, { numeric: true }),
    coverHints: new Set(["cover", "folder"]),
    createId: (prefix, value) => `${prefix}:${value}`,
    emptyLibrary: () => ({
      availableRoots: [], missingRoots: [], people: [], peopleById: new Map(), worksById: new Map(),
      filesById: new Map(), fileRefCounts: new Map(), totals: {}
    }),
    excludedDirs: new Set(),
    excludedRoots,
    fileBase: (name) => path.parse(name).name,
    isExcludedDirName: () => false,
    isImage: (name) => [".jpg", ".jpeg", ".png"].includes(path.extname(name).toLowerCase()),
    isInfo: (name) => [".nfo", ".txt"].includes(path.extname(name).toLowerCase()),
    isPlayableVideo: (name) => path.extname(name).toLowerCase() === ".mp4",
    isVideo: (name) => [".mp4", ".wmv"].includes(path.extname(name).toLowerCase()),
    libraryRoots,
    normalizeExt: (name) => path.extname(name).toLowerCase(),
    relativeFromRoot: (name) => path.relative(libraryRoots[0], name),
    safeStat: (name) => fs.statSync(name),
    singleVideoRoots
  });

  const westernWorks = createService([westernRoot]).scanPersonDirectory("person-1", personDir);
  assert.equal(westernWorks.length, 2, "Western scan must create one work per video");
  assert.deepEqual(westernWorks.map((work) => work.title), ["alpha.mp4", "beta.wmv"]);
  assert.ok(westernWorks.every((work) => work.videoCount === 1));
  assert.ok(westernWorks.every((work) => path.extname(work.relativePath)), "Western work identity must be its video path");
  assert.equal(westernWorks[0].imageCount, 1, "Same-basename image should stay with its video");
  assert.equal(westernWorks[1].imageCount, 0, "Shared folder image must not leak across multiple videos");

  const groupedWorks = createService([]).scanPersonDirectory("person-1", personDir);
  assert.equal(groupedWorks.length, 1, "Non-Western scanning must retain folder grouping");
  assert.equal(groupedWorks[0].videoCount, 2);

  const mainRoot = path.join(fixtureRoot, "O");
  const animeRoot = path.join(mainRoot, "[动漫]");
  const regularPersonDir = path.join(mainRoot, "Aoi");
  fs.mkdirSync(animeRoot, { recursive: true });
  fs.mkdirSync(regularPersonDir, { recursive: true });
  fs.writeFileSync(path.join(animeRoot, "anime.mp4"), "anime");
  fs.writeFileSync(path.join(regularPersonDir, "regular.mp4"), "regular");
  const mainLibrary = createService([], [mainRoot], [animeRoot]).scanLibrary();
  assert.deepEqual(mainLibrary.people.map((person) => person.name), ["Aoi"], "anime media root must be excluded from the FanHao people scan");

  console.log("Western video scan verification passed.");
} finally {
  const resolved = path.resolve(fixtureRoot);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
