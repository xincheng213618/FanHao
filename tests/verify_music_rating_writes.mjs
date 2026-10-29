import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMusicReaderFixture } from "./verify_music_reader_requests.mjs";

// Actual music host, star buttons and a private persistent rating endpoint.
// Controlled Audio checks playback invariants; no real library is accessed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseOption = process.argv.find(value => value.startsWith("--case="));
const negativeOnly = process.argv.includes("--negative-only");
assert(!(caseOption && negativeOnly), "--case and --negative-only cannot be combined");
if (!negativeOnly) await runMusicReaderFixture({ casePattern: caseOption?.slice(7) || "rating " });
if (!caseOption) {
  const source = fs.readFileSync(path.join(root, "public/modules/music/actions.js"), "utf8").replaceAll("\r\n", "\n");
  for (const negative of [
    { name: "serialized rating commits", casePattern: "rating writes preserve the last selected score ignore-abort", marker: "const job = { rating, owner, resolve };\n      if (writes.active) {", replacement: "const job = { rating, owner, resolve };\n      if (false) {", failure: /the last selected score must remain persisted when an earlier rating write finishes late/ },
    { name: "confirmed-score rollback", casePattern: "rating writes retain the confirmed score after latest failure and retry", marker: "if (data.track) writes.confirmed = { id: trackId, rating: data.track.rating };", replacement: "if (data.track && !writes.pending) writes.confirmed = { id: trackId, rating: data.track.rating };", failure: /a failed last write must retain and explain the last confirmed score/ },
    { name: "rating account ownership", casePattern: "rating writes discard unsent old-account choices after owner changes", marker: "return account.owner === owner.webAccountOwner && account.revision === owner.webAccountRevision;", replacement: "return true;", failure: /an unsent old-account score must not use the new account's credentials/ },
    { name: "confirmed-score refresh generation ownership", casePattern: "rating writes confirmed-score refresh preserves new request error", marker: "refreshed.generation !== musicLoadGeneration", replacement: "false", additional: [{ marker: "current && errorGeneration === musicLoadGeneration &&", replacement: "current &&" }], failure: /an obsolete confirmed-score refresh must not cover newer navigation or request errors/ },
    { name: "latest rating-error UI intent", casePattern: "rating writes confirmed-score refresh preserves new score failure", marker: "if (latestRatingUiIntent !== owner) {", replacement: "if (false) {", additional: [{ marker: "if (current && errorGeneration === musicLoadGeneration && isRatingContextCurrent(owner) && latestRatingUiIntent === owner) {", replacement: "if (current && errorGeneration === musicLoadGeneration && isRatingContextCurrent(owner)) {" }], failure: /an obsolete confirmed-score refresh must not cover newer navigation or request errors/ },
    { name: "successful-score refresh error intent", casePattern: "rating writes successful-score refresh failures preserve a later score error", marker: "if (canReportRatingFailure(owner) && refreshed?.generation === musicLoadGeneration", replacement: "if (refreshed?.generation === musicLoadGeneration", additional: [{ marker: "if (isRatingContextCurrent(owner) && latestRatingUiIntent === owner && trackMetadataRequiresReload(\"rating\")) {\n        const pending = loadMusic({ replaceRoute: true, keepCurrent: true,\n          canReportFailure: () => canReportRatingFailure(owner),", replacement: "if (isRatingContextCurrent(owner) && latestRatingUiIntent === owner && trackMetadataRequiresReload(\"rating\")) {\n        const pending = loadMusic({ replaceRoute: true, keepCurrent: true,\n          canReportFailure: () => true," }], failure: /an old successful-score refresh error must not replace a newer rating failure cause/ }
  ]) {
    let mutated = source;
    for (const change of [negative, ...(negative.additional || [])]) {
      assert.equal(mutated.split(change.marker).length - 1, 1, `negative must modify its current owning behavior: ${negative.name}`);
      mutated = mutated.replace(change.marker, change.replacement);
    }
    await assert.rejects(() => runMusicReaderFixture({ casePattern: negative.casePattern, sourceOverrides: { "/modules/music/actions.js": mutated } }), { name: "AssertionError", message: negative.failure });
    console.log(`PASS negative control detects missing ${negative.name}`);
  }
}
