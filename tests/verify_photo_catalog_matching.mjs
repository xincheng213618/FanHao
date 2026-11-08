import assert from "node:assert/strict";
import test from "node:test";
import { photoIssueCode, rankPhotoArchiveCandidates } from "../src/modules/photos/server/photo-catalog-matching.js";

const archive = (id, title) => ({ id, title });

test("a full split issue and a declaration-free title survive a noisy first page", () => {
  const wrong = Array.from({ length: 15 }, (_, index) => archive(`wrong-${index}`, `Different title NO.113 ${index}`));
  const nearby = archive("nearby", "Studio B NO.1132");
  const exactIssue = archive("number", "Alternative title N0_0113-02");
  const exactTitle = archive("title", "Studio B NO.113-2");
  const weakIssue = archive("weak", "VOL.113-2 alternate label");
  const albums = [...wrong, nearby, weakIssue, exactIssue, exactTitle];
  const result = rankPhotoArchiveCandidates({
    title: "Studio B NO.113-2 ［189P+1V／2.74GB］", issueCode: "NO.113-2", issueLabel: "113-2"
  }, albums, { limit: 2 });
  assert.deepEqual(result, { albums: [exactTitle, exactIssue], total: 3 });
  assert.equal(albums[0], wrong[0], "preserve the input order and objects");
});

test("only a pure trailing declaration can make two titles exact", () => {
  const issue = { title: "Title (旧版)【100P / 4.2 GB】" };
  const original = archive("original", "Title (旧版)");
  const other = archive("other", "Title (新版)");
  const unrelated = archive("unrelated", "Title (旧版 100P)");
  assert.deepEqual(rankPhotoArchiveCandidates(issue, [other, unrelated, original]), { albums: [original], total: 1 });
  assert.deepEqual(rankPhotoArchiveCandidates({ title: "Title (旧版)［80P1V-2.66GB］" }, [other, unrelated, original]), {
    albums: [original], total: 1
  });
  assert.deepEqual(rankPhotoArchiveCandidates({ title: "Title (新版 100P)" }, [other, unrelated, original], { limit: 1 }), {
    albums: [], total: 0
  });
});

test("a qualifying badge can refine a bare issue, while an open-ended badge cannot invent a match", () => {
  const regular = archive("regular", "Alt VOL.113");
  const part = archive("part", "Alt VOL.113-2");
  const old = archive("legacy", "113-2. Old naming");
  assert.deepEqual(rankPhotoArchiveCandidates({ title: "New VOL.113", issueCode: "VOL.113", issueLabel: "113-2" }, [regular, old, part]), {
    albums: [part, old], total: 2
  });
  assert.deepEqual(rankPhotoArchiveCandidates({ title: "No number", issueLabel: "113+" }, [regular, part], { limit: 1 }), {
    albums: [], total: 0
  });
});

test("legacy leading sequences help without treating dates or incomplete identifiers as issues", () => {
  const date = archive("date", "2025.08.02 Archive");
  const sequence = archive("legacy", "008. Archive");
  const issue = archive("issue", "Archive N0.008");
  const malformed = archive("malformed", "Archive NO.008-12345");
  assert.deepEqual(rankPhotoArchiveCandidates({ title: "Other NO.8", issueCode: "NO.8" }, [date, sequence, malformed, issue]), {
    albums: [issue, sequence], total: 2
  });
  assert.deepEqual(rankPhotoArchiveCandidates({ title: "Unknown", issueLabel: "2025" }, [date, sequence], { limit: 1 }), {
    albums: [], total: 0
  });
  assert.equal(photoIssueCode("Archive N0.008-02"), "NO.008-02");
  assert.equal(photoIssueCode("008. Legacy"), "");
});

test("a manual query replaces automatic matching and keeps hyphenated issue searches distinct", () => {
  const exact = archive("exact", "Studio A NO.113");
  const other = archive("other", "Studio B NO.113-2");
  const adjoiningDigits = archive("digits", "Studio B NO.1132");
  const albums = [exact, other, adjoiningDigits];
  assert.deepEqual(rankPhotoArchiveCandidates({ title: exact.title }, albums, { query: "no.113-2" }), { albums: [other], total: 1 });
  assert.deepEqual(rankPhotoArchiveCandidates({ title: exact.title }, albums, { query: "Studio B", limit: 1 }), {
    albums: [other], total: 2
  });
  assert.deepEqual(rankPhotoArchiveCandidates({ title: exact.title }, albums, { query: "nothing" }), { albums: [], total: 0 });
});

test("unknown titles retain a small group's original choice list", () => {
  const albums = [archive("a", "First"), archive("b", "Second")];
  const entry = { title: "Unmatched" };
  assert.deepEqual(rankPhotoArchiveCandidates(entry, albums, { limit: 2 }), { albums, total: 2 });
  assert.deepEqual(rankPhotoArchiveCandidates(entry, albums, { limit: 1 }), { albums: [], total: 0 });
});
