import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Actual standalone host and metadata recovery controls; synthetic reads only.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const result = await runNovelReaderFixture({ casePattern: caseOption?.slice(7) || "book metadata recovery " });
  assert(result.checks > 0, "the selected book metadata recovery cases must exist");
}
if (!caseOption) {
  const source = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const catchOwner = 'if (!isCurrentNavigation(navigation)) return false;\n      finishNavigation(navigation);\n      state.novel.loading = false;\n      state.novel.status = error.message || "书籍详情读取失败";';
  for (const control of [
    { name: "visible target metadata failure", pattern: "book metadata recovery exposes a failed direct link and retries its target ignore-abort",
      marker: "bookRecovery = { owner: navigation.id, bookId: String(bookId), message: state.novel.status,", replacement: "if (false) bookRecovery = { owner: navigation.id, bookId: String(bookId), message: state.novel.status,",
      failure: /a failed direct book link must expose its metadata error instead of claiming that the library is empty/ },
    { name: "obsolete retry failure ownership", pattern: "book metadata recovery retires late retry failure after newer navigation ignore-abort",
      marker: catchOwner, replacement: catchOwner.replace("if (!isCurrentNavigation(navigation)) return false;", ""),
      failure: /late metadata retry completion must preserve the newer reader DOM and status/ },
    { name: "new composing search preservation", pattern: "book metadata recovery keeps newer composing search and focus on retry success ignore-abort",
      marker: "if (reuseBookRecoveryMenu()) return;", replacement: "",
      failure: /book retry completion must keep a newer composing search form connected/ },
    { name: "failed-open source cache reuse", pattern: "book metadata recovery returns to the unchanged loaded source ignore-abort",
      marker: "const unopenedSource = !currentBook && currentBookRecovery()?.bookId === context.bookId;", replacement: "const unopenedSource = false;",
      failure: /a failed book open must return to its unchanged source without refetching or losing the loaded prefix/ }
  ]) {
    assert.equal(source.split(control.marker).length - 1, 1, `negative must modify one current behavior: ${control.name}`);
    await assert.rejects(() => runNovelReaderFixture({ casePattern: control.pattern,
      sourceOverrides: { "/modules/novels/novel-page.js": source.replace(control.marker, control.replacement) }
    }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
