import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createShortVideoImportItemMapper } from "../src/modules/short-videos/server/import-item-mapper.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/modules/short-videos/download-manager/extract-links.mjs"), "utf8");
const names = ["workFromHref", "firstString", "firstNumber", "firstUrl", "firstUrlAny",
  "extractAuthor", "extractPreview", "workFromObject", "addWork"];
const bodies = names.map((name) => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\nfunction ", start + 1);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
});
const context = vm.createContext({ URL });
const fieldsStart = source.indexOf("const REFRESHED_WORK_FIELDS =");
const fieldsEnd = source.indexOf("\nfunction addWork(", fieldsStart);
assert.ok(fieldsStart >= 0 && fieldsEnd > fieldsStart);
vm.runInContext(source.slice(fieldsStart, fieldsEnd) + "\n" + bodies.join("\n"), context);
const evaluate = (expression) => JSON.parse(JSON.stringify(vm.runInContext(expression, context)));
const id = "7990000000000000001";
assert.equal(evaluate(`workFromHref("https://www.douyin.com/article/${id}/")`).kind, "article");
const article = evaluate(`workFromObject({
  aweme_id: "${id}", images: [{url_list: ["https://example.com/cover.png"]}],
  desc: "摘要", article_info: {article_title: "完整标题", article_content: "{}"},
  author: {nickname: "作者", sec_uid: "test"}
})`);
assert.equal(article.kind, "article");
assert.equal(article.media_type, "article");
assert.equal(article.desc, "完整标题");
assert.equal(article.url, `https://www.douyin.com/article/${id}`);
context.article = article;
const merged = evaluate(`(() => {
  const works = new Map(), pending = [];
  addWork(works, pending, workFromHref("https://www.douyin.com/video/${id}"));
  addWork(works, pending, article);
  addWork(works, pending, workFromHref("https://www.douyin.com/video/${id}"));
  return [...works.values()];
})()`);
assert.equal(merged.length, 1);
assert.equal(merged[0].kind, "article");
assert.equal(merged[0].media_type, "article");
assert.equal(evaluate(`workFromObject({aweme_id:"${id}", images:[{}]})`).kind, "note");
assert.equal(evaluate(`workFromObject({aweme_id:"${id}", video:{}})`).kind, "video");

const mapper = createShortVideoImportItemMapper({
  hashText: () => "", optionalInteger: (value) => Number(value) || null,
  parseJsonObject: (value) => JSON.parse(value || "{}"),
  safeStat: () => { throw new Error("Article must be excluded before probing media"); },
});
assert.equal(mapper.downloadManagerRowToItem({media_type: "article", kind: "note"}), null);
assert.equal(mapper.downloadManagerRowToItem({kind: "article"}), null);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-article-boundary-"));
const metadataPath = path.join(temporary, `${id}_data.json`);
const imagePath = path.join(temporary, `${id}_article_1.jpg`);
try {
  fs.writeFileSync(metadataPath, JSON.stringify({
    aweme_id: id, images: [{}], article_info: {article_title: "正文", article_content: "{}"},
  }));
  fs.writeFileSync(imagePath, "fixture-image");
  assert.equal(mapper.parseGalleryDirectory(temporary, temporary), null,
    "An article's companion images must not become a gallery during a folder scan");
} finally {
  for (const file of [metadataPath, imagePath]) if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.rmdirSync(temporary);
}
console.log("Douyin article extraction and library boundary checks passed.");
