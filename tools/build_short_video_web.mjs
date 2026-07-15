import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "public", "short-video-app.js");
const output = path.join(root, "public", "short-video-app.min.js");
const indexPath = path.join(root, "public", "index.html");
const checkOnly = process.argv.includes("--check");

const result = await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["chrome110", "edge110"],
  legalComments: "none",
  charset: "utf8",
  treeShaking: true,
  write: false,
  outfile: output
});

const generated = result.outputFiles?.[0]?.contents;
assert(generated?.length, "short-video production bundle was empty");
const bundleHash = createHash("sha256").update(generated).digest("hex").slice(0, 12);
const bundleUrl = `/short-video-app.min.js?v=bundle-${bundleHash}`;
const bundleUrlPattern = /\/short-video-app\.min\.js\?v=[^"']+/g;

function synchronizedIndexSource() {
  const source = fs.readFileSync(indexPath, "utf8");
  const urls = source.match(bundleUrlPattern) || [];
  assert.equal(urls.length, 2, "public/index.html must contain exactly two production short-video bundle URLs");
  return source.replace(bundleUrlPattern, bundleUrl);
}

if (checkOnly) {
  const existing = fs.readFileSync(output);
  assert(existing.equals(generated), "public/short-video-app.min.js is stale; run npm run build:short-video-web");
  const indexSource = fs.readFileSync(indexPath, "utf8");
  assert.equal(indexSource, synchronizedIndexSource(), "public/index.html points at a stale short-video bundle version; run npm run build:short-video-web");
  console.log(`short-video-web-build: current (${generated.length} bytes, ${bundleHash})`);
} else {
  // Publish the bytes before exposing their immutable content version. This
  // prevents a browser from caching old bytes under a newly announced URL.
  fs.writeFileSync(output, generated);
  const indexSource = synchronizedIndexSource();
  fs.writeFileSync(indexPath, indexSource);
  console.log(`short-video-web-build: wrote ${path.relative(root, output)} (${generated.length} bytes, ${bundleHash})`);
}
