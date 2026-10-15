// Frozen verbatim from src/modules/novels/server/store.js, 2026-08-30.
// The verifier compares LF-normalized function text AND SHA-256 with production.
export const legacySourceHashes = Object.freeze({
  clampReadingProgress: "05d4603b07fe8f05e2315d142a58e56dc247b8f5fcbb7aca202fb131e612503c",
  chapterId: "0491a0e61ea6199731987984ae6c36ea28f1dfc7f7f1c6105d82c88f019caa30",
});

function clampReadingProgress(database, bookId, chapterCount) {
  const progress = database
    .prepare("SELECT chapter_index, scroll_ratio, updated_at FROM novel_reading_state WHERE book_id = ?")
    .get(bookId);
  if (!progress) return;
  if (chapterCount <= 0) {
    database.prepare("DELETE FROM novel_reading_state WHERE book_id = ?").run(bookId);
    return;
  }
  const previousIndex = Math.max(1, Number(progress.chapter_index || 1));
  const chapterIndex = Math.min(previousIndex, chapterCount);
  database
    .prepare(
      `
      UPDATE novel_reading_state
      SET chapter_id = ?, chapter_index = ?, scroll_ratio = ?, updated_at = ?
      WHERE book_id = ?
    `
    )
    .run(
      chapterId(bookId, chapterIndex),
      chapterIndex,
      chapterIndex === previousIndex ? Number(progress.scroll_ratio || 0) : 0,
      progress.updated_at || new Date().toISOString(),
      bookId
    );
}

function chapterId(bookId, index) {
  return `${bookId}-${String(index).padStart(5, "0")}`;
}

export { clampReadingProgress, chapterId };
