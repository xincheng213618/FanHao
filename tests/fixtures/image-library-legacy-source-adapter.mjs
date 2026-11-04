import assert from "node:assert/strict";

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
