import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertAndroidCacheVersion, planAndroidCacheVersion, syncAndroidCacheVersion } from "./android-cache-version.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-cache-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  write("js/config.js", 'export const CLIENT_VERSION = "old-version";\r\n');
  write("index.html", '<script src="./app.js?v=stale" type="module"></script>\r\n<link href="./styles.css?v=old&theme=dark">\r\n');
  write("app.js", 'import { CLIENT_VERSION } from "./js/config.js?v=different";\r\nfetch("https://example.test/app.js?v=remote");\r\nfetch("/api/items?v=api");\r\n');
  write("styles.css", '@import "./nested/style.css?v=older";\r\n');
  write("nested/style.css", "body { color: red; }\r\n");
  return { root, write, read: (file) => fs.readFileSync(path.join(root, file), "utf8") };
}

test("sync repairs stale references, preserves unrelated URLs and is idempotent", (t) => {
  const f = fixture(t);
  assert.throws(() => assertAndroidCacheVersion(f.root), /need synchronization/);
  const first = syncAndroidCacheVersion(f.root);
  assert.match(first.version, /^assets-[a-f0-9]{12}$/);
  assert(f.read("index.html").includes(`styles.css?v=${first.version}&theme=dark`));
  assert(f.read("app.js").includes(`config.js?v=${first.version}`));
  assert(f.read("app.js").includes("https://example.test/app.js?v=remote"));
  assert(f.read("app.js").includes("/api/items?v=api"));
  assert(f.read("app.js").includes("\r\n"));
  assert.equal(assertAndroidCacheVersion(f.root).version, first.version);
  assert.equal(syncAndroidCacheVersion(f.root).changes.length, 0);
});

test("nested source edits and additions invalidate the identity", (t) => {
  const f = fixture(t);
  const initial = syncAndroidCacheVersion(f.root).version;
  f.write("nested/style.css", "body { color: blue; }\r\n");
  const edited = syncAndroidCacheVersion(f.root).version;
  assert.notEqual(edited, initial);
  f.write("nested/new.js", "export const newFeature = true;\n");
  assert.notEqual(syncAndroidCacheVersion(f.root).version, edited);
});

test("checks are read-only and line endings do not change the hash", (t) => {
  const f = fixture(t);
  const original = f.read("app.js");
  const before = planAndroidCacheVersion(f.root);
  assert.equal(f.read("app.js"), original);
  for (const file of ["js/config.js", "index.html", "app.js", "styles.css", "nested/style.css"]) f.write(file, f.read(file).replaceAll("\r\n", "\n"));
  assert.equal(planAndroidCacheVersion(f.root).version, before.version);
});

test("a missing version declaration fails without writing files", (t) => {
  const f = fixture(t);
  f.write("js/config.js", "export const SERVER = 'fixture';\n");
  const before = f.read("app.js");
  assert.throws(() => syncAndroidCacheVersion(f.root), /CLIENT_VERSION exactly once/);
  assert.equal(f.read("app.js"), before);
});
