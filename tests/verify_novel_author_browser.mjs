import assert from "node:assert/strict";
import fs from "node:fs";
import { runNovelReaderFixture } from "./verify_novel_reader_requests.mjs";

// Real library/native dialog, isolated Chromium and synthetic authors only.
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) {
  const result = await runNovelReaderFixture({ casePattern: caseOption?.slice(7) || "author discovery " });
  assert(result.checks > 0, "the selected author discovery scenarios must exist");
}
if (!caseOption) {
  const source = fs.readFileSync(new URL("../public/modules/novels/author-browser.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const pageSource = fs.readFileSync(new URL("../public/modules/novels/novel-page.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const responseGuard = 'const data = await api(`/api/novels/authors?${params}`, { signal: controller.signal });\n      if (!current() || id !== requestId) return;';
  for (const control of [
    { name: "bounded author pages", pattern: "author discovery browses the existing author index without replacing the book list ignore-abort",
      marker: "const NOVEL_AUTHOR_PAGE_SIZE = 48;", replacement: "const NOVEL_AUTHOR_PAGE_SIZE = 5000;",
      failure: /five thousand authors must render as one bounded page/ },
    { name: "delivered author cursor", pattern: "author discovery paginates delivered authors and resets sorted searches ignore-abort",
      marker: "nextOffset: offset + data.authors.length", replacement: "nextOffset: offset + NOVEL_AUTHOR_PAGE_SIZE",
      failure: /the next author page must continue after delivered rows rather than the requested page size/ },
    { name: "replaced author response ownership", pattern: "author discovery ignores replaced-query success and failure ignore-abort",
      marker: responseGuard, replacement: responseGuard.replace("!current() || id !== requestId", "!current()"),
      failure: /a superseded author read must not populate a newer query while it is pending/ },
    { name: "latest author finalizer ownership", pattern: "author discovery ignores replaced-query success and failure ignore-abort",
      marker: "if (current() && id === requestId) {", replacement: "if (current()) {",
      failure: /an old author finalizer must not release the newer read's busy state/ },
    { name: "closed author request cancellation", pattern: "author discovery closes and reopens without old callbacks taking ownership ignore-abort",
      marker: "requestId++; controller?.abort(); lifetime.abort();", replacement: "requestId++; lifetime.abort();",
      failure: /closing author discovery must abort its pending read/ },
    { name: "IME author submission deferral", pattern: "author discovery composes Chinese input and selects the canonical author view ignore-abort",
      marker: "if (current() && !composing) void load(", replacement: "if (current()) void load(",
      failure: /IME candidate confirmation must not submit a partial author search/ },
    { name: "explicit unknown-author group navigation", pattern: "author discovery opens the explicit unknown author group ignore-abort",
      source: pageSource, path: "/modules/novels/novel-page.js",
      marker: "allowUnknownAuthor: true", replacement: "allowUnknownAuthor: false",
      failure: /an explicit unknown-author directory group must open its author route instead of silently closing the dialog/ }
  ]) {
    const currentSource = control.source || source;
    assert.equal(currentSource.split(control.marker).length - 1, 1, `negative must modify one current behavior: ${control.name}`);
    await assert.rejects(() => runNovelReaderFixture({ casePattern: control.pattern,
      sourceOverrides: { [control.path || "/modules/novels/author-browser.js"]: currentSource.replace(control.marker, control.replacement) }
    }), { name: "AssertionError", message: control.failure });
    console.log(`PASS negative control detects missing ${control.name}`);
  }
}
