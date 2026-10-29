import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Actual reader/detail UI, isolated browser storage and synthetic chapter APIs.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const result = await runNovelReaderFixture({ casePattern: caseOption?.slice(7) || "reader bookmarks " });
  assert(result.checks > 0, "the selected local bookmark cases must exist");
}
if (!caseOption) {
  const read = name => fs.readFileSync(new URL(`../public/modules/novels/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const page = read("novel-page.js"), bookmarks = read("bookmarks.js");
  for (const control of [
    { name: "same-chapter saved ratio", source: page, path: "novel-page.js", pattern: "reader bookmarks save multiple precise places without rebuilding long text ignore-abort",
      marker: "state.novel.pendingScrollRatio = mark.ratio;", replacement: "state.novel.pendingScrollRatio = 0;",
      failure: /a same-chapter bookmark must restore its exact saved percentage/ },
    { name: "account bookmark isolation", source: bookmarks, path: "bookmarks.js", pattern: "reader bookmarks separate account owners and preserve old account data ignore-abort",
      marker: '[account.owner || "guest", book.sourceRealm, String(book.id)]', replacement: '[book.sourceRealm, String(book.id)]',
      failure: /a new account must not inherit another account's bookmarks/ },
    { name: "chapter identity validation before caching", source: page, path: "novel-page.js", pattern: "reader bookmarks reject a mismatched chapter response before caching and can retry ignore-abort",
      marker: "|| (options.expectedChapterId && data.chapter?.id !== options.expectedChapterId)", replacement: "",
      failure: /a mismatched bookmark chapter must not poison the cache used by the next retry/ },
    { name: "honest storage failure", source: bookmarks, path: "bookmarks.js", pattern: "reader bookmarks keep a bounded usable mobile list and recover storage failures ignore-abort",
      marker: "write(next); render(next); details.open = true;", replacement: "try { write(next); } catch {} render(next); details.open = true;",
      failure: /a rejected storage write must not display a bookmark as saved/ },
    { name: "outdated catalog availability", source: bookmarks, path: "bookmarks.js", pattern: "reader bookmarks separate realms books and disable outdated revisions ignore-abort",
      marker: "open.disabled = item.catalogRevision !== book.catalogRevision;", replacement: "open.disabled = false;",
      failure: /bookmarks from an outdated catalog revision must be visibly unavailable for navigation/ },
    { name: "bounded scalar storage normalization", source: bookmarks, path: "bookmarks.js", pattern: "reader bookmarks normalize damaged records and preserve unreadable storage ignore-abort",
      marker: "items.push({ id: item.id, chapterId: item.chapterId, catalogRevision: item.catalogRevision, chapterIndex: item.chapterIndex, title: item.title.slice(0, 160), ratio: item.ratio });",
      replacement: "items.push({ ...item, title: item.title.slice(0, 160) });",
      failure: /persisted bookmarks must contain only bounded scalar fields instead of echoing unknown body or nested data/ }
  ]) {
    assert.equal(control.source.split(control.marker).length - 1, 1, `negative must modify one current behavior: ${control.name}`);
    await assert.rejects(() => runNovelReaderFixture({ casePattern: control.pattern,
      sourceOverrides: { [`/modules/novels/${control.path}`]: control.source.replace(control.marker, control.replacement) }
    }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
