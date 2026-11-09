import assert from "node:assert/strict";
import fs from "node:fs";

const libraryUrl = new URL("../../src/modules/content-index/server/image-library-service.js", import.meta.url);

export function readImageLibrarySource() {
  // The instrumented copies run as data URLs, with no base for relative imports.
  return fs.readFileSync(libraryUrl, "utf8").replaceAll("\r\n", "\n")
    .replace(/\bfrom\s+(["'])(\.{1,2}\/[^"'\r\n]+)\1/g,
      (_match, _quote, relative) => "from " + JSON.stringify(new URL(relative, libraryUrl).href));
}

// Earlier algorithm oracles restore exact source fragments inside the list
// builder. Keep those fragments independent of the new optional read scope;
// the movie cold-projection fixture tests that scope against frozen owners.
export function sourceBeforeMovieColdScope(source) {
  const start = "    function buildItems(movieListRead) {\n";
  const end = "\n    }\n  }\n\n  function movieListExceedsCache(";
  const optional = 'if (mode === "movie" && !query && movieListExceedsCache(';
  const revision = 'listRevision: movieListRead ? "" : publicListRevision';
  for (const marker of [start, end, optional, revision]) assert.equal(source.split(marker).length, 2, "one movie read-scope adapter boundary");
  const bodyStart = source.indexOf(start) + start.length;
  const bodyEnd = source.indexOf(end, bodyStart);
  assert(bodyEnd > bodyStart);
  const body = source.slice(bodyStart, bodyEnd).replace(/^ {2}/gm, "");
  return (source.slice(0, bodyStart) + body + source.slice(bodyEnd))
    .replace(optional, 'if (false && mode === "movie" && !query && movieListExceedsCache(')
    .replace(revision, "listRevision: publicListRevision");
}
