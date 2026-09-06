// All names/text/identities in this file are invented, never loaded from a user DB.
export const LIBRARY = "personal-test-library";
export const OTHER_LIBRARY = "other-test-library";
export const PRIVATE_MARKER = "PRIVATE_BODY_NOT_METADATA";

export function legacyRecord({ rowId = "a-imported", libraryId = LIBRARY, realm = "device:fixture-install",
  legacyId = "same-old-id", sourceType = "local-file", indices = [10, 30, 20], progress,
  modify = () => {} } = {}) {
  const entry = {
    id: legacyId,
    book: {
      id: legacyId, title: "同名合成小说", author: "合成作者", category: "测试", local: true,
      sourceType, fileName: `${rowId}.txt`, updatedAt: "2026-01-02T03:04:05.000Z",
      progress: progress ?? { chapterIndex: indices[1] ?? indices[0], scrollRatio: 0.375, updatedAt: "2026-01-02T04:00:00.000Z", unknownText: PRIVATE_MARKER.repeat(5) },
      sourceKey: `${PRIVATE_MARKER}:first-and-last-fragments`, sourceUrl: "https://not-an-authority.invalid/private",
      metadata: { futureFlag: true, nested: { preserve: "book extension" } },
      contents: PRIVATE_MARKER.repeat(20)
    },
    chapters: indices.map((index, ordinal) => ({ id: `old-chapter-${index}`, bookId: legacyId, index,
      title: `合成第${ordinal + 1}章`, content: `正文 ${rowId}/${index}\n${PRIVATE_MARKER}-${ordinal}`,
      futureChapter: { unknown: ordinal, nested: [true, "preserve chapter"] } })),
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T03:04:05.000Z",
    bytes: 999, importFingerprint: "unknown-entry-field", futureEntry: { deep: [1, 2, 3] }
  };
  modify(entry);
  // Formatting and escaped Unicode deliberately differ from JSON.stringify(parse).
  const rawJson = JSON.stringify(entry, null, 2).replaceAll("正文", "\\u6b63\\u6587") + "\n";
  return { rowId, libraryId, realm, legacyId, rawJson };
}

export function legacyLibrary() {
  return [
    legacyRecord(),
    legacyRecord({ rowId: "b-server-one", realm: "server:fixture-library-one", sourceType: "remote-cache" }),
    legacyRecord({ rowId: "c-server-two", realm: "server:fixture-library-two", sourceType: "remote-cache" }),
    legacyRecord({ rowId: "d-unbound-cache", realm: null, sourceType: "remote-cache" }),
    legacyRecord({ rowId: "e-other-library", libraryId: OTHER_LIBRARY }),
    legacyRecord({ rowId: "f-unresolved", legacyId: "missing-old-chapter", progress: { chapterIndex: 999, scrollRatio: 0.8, unknownText: PRIVATE_MARKER } }),
    legacyRecord({ rowId: "g-unbound-imported", legacyId: "unbound-imported", realm: null }),
    legacyRecord({ rowId: "h-contradictory-position", legacyId: "contradictory", progress: { chapterIndex: 10, chapterId: "wrong-old-chapter", scrollRatio: 0.5 } })
  ];
}
