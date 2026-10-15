import * as storage from "/android-client/js/local-novels.js";
export { deleteLocalNovelEntry, loadLocalNovelEntries, loadLocalNovelSummaries, readLocalNovelSummary, readLocalNovelCatalog, saveLocalNovelEntry, listLocalNovelRecoveryBooks, readLocalNovelRecoveryEntry } from "/android-client/js/local-novels.js";

export async function readLocalNovelEntry(id) {
  if (id === "local:fixture:A" && window.readerFixture.holdRead) {
    window.readerFixture.notice("A 的读取正在等待释放");
    await new Promise((resolve) => window.readerFixture.readers.push(resolve));
  }
  return storage.readLocalNovelEntry(id);
}

export async function readLocalNovelChapter(id, index) {
  if (id === "local:fixture:A" && window.readerFixture.holdRead) {
    window.readerFixture.notice("A 的章节读取正在等待释放");
    await new Promise((resolve) => window.readerFixture.readers.push(resolve));
  }
  return storage.readLocalNovelChapter(id, index);
}

export async function saveLocalNovelProgress(id, progress, options) {
  const result = await storage.saveLocalNovelProgress(id, progress, options);
  window.readerFixture.writes.push({ id, progress, options });
  if (id === "local:fixture:A" && window.readerFixture.holdSave) {
    window.readerFixture.notice("A 的保存完成回调正在等待释放");
    await new Promise((resolve) => window.readerFixture.saves.push(resolve));
  }
  window.readerFixture.updateWrites();
  return result;
}
