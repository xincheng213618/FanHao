import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CURRENT_INDEX_SCHEMA, PARSER_VERSION } from "../src/modules/content-index/server/image-library-index-contract.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-rescan-fixture-"));
try {
  const photoRoot = path.join(tempDir, "photos");
  const movieRoot = path.join(tempDir, "movies");
  const tvRoot = path.join(tempDir, "tv");
  const dataDir = path.join(tempDir, "data");
  fs.mkdirSync(photoRoot, { recursive: true });
  fs.mkdirSync(movieRoot, { recursive: true });
  fs.mkdirSync(tvRoot, { recursive: true });
  fs.writeFileSync(path.join(photoRoot, "fixture.zip"), "fixture");
  fs.writeFileSync(path.join(movieRoot, "fixture.mp4"), "fixture");
  const env = {
    ...process.env,
    FANHAO_DATA_DIR: dataDir,
    FANHAO_PHOTO_SET_ROOTS: photoRoot,
    FANHAO_MOVIE_ROOTS: movieRoot,
    FANHAO_TV_ROOTS: tvRoot
  };
  const run = () => spawnSync(process.execPath, ["tools/rescan_image_library.mjs", "--scope", "all"], {
    cwd: repoRoot, encoding: "utf8", env, windowsHide: true
  });
  const firstRun = run();
  assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
  const indexPath = path.join(dataDir, "image-library-index.json");
  const first = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.equal(first.schemaVersion, CURRENT_INDEX_SCHEMA);
  assert.equal(first.parserVersion, PARSER_VERSION);
  assert.deepEqual(first.photoSets.map((item) => item.title), ["fixture"]);
  assert.deepEqual(first.mediaItems.map((item) => item.title), ["fixture"]);
  fs.writeFileSync(indexPath, JSON.stringify({ ...first, cacheIdentity: "wrong", photoSets: [{ title: "stale" }] }));
  const secondRun = run();
  assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
  const second = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.deepEqual(second.photoSets.map((item) => item.title), ["fixture"], "rescan must reject an incompatible persisted index");
  console.log("rescan-image-library: ok");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
