// Frozen from the production picker and busy helpers before deferred URI reads.
// Used as executable negative controls, not a second implementation of the fix.
export const functions = {
  setNovelBusy: String.raw`  function setNovelBusy(action) {
    listState.uploading = true;
    listState.busyAction = action || "";
  }`,
  clearNovelBusy: String.raw`  function clearNovelBusy() {
    listState.uploading = false;
    listState.busyAction = "";
  }`,
  importFromSystemFileManager: String.raw`  function importFromSystemFileManager() {
    const plugin = nativeNovelPlugin();
    if (!plugin?.openTextDocumentPicker) {
      const localInput = createLocalNovelInput();
      localInput.click();
      return;
    }
    if (listState.uploading) return;
    setNovelBusy("picker");
    setStatus?.("正在打开系统文件管理器");
    renderCurrentView();

    Promise.resolve()
      .then(async () => {
        const result = await plugin.openTextDocumentPicker();
        const items = Array.isArray(result?.items) ? result.items : [];
        const errors = Array.isArray(result?.errors) ? result.errors : [];
        if (result?.canceled) {
          clearNovelBusy();
          setStatus?.("已取消文件管理器导入。");
          renderCurrentView();
          return;
        }
        if (!items.length) {
          clearNovelBusy();
          setStatus?.(errors.length ? ` + "`没有导入 TXT，${formatNumber(errors.length)} 个文件读取失败或不是 TXT。`" + String.raw` : "没有选择可导入的 TXT。", errors.length ? "error" : "");
          renderCurrentView();
          return;
        }

        let imported = 0;
        let skipped = 0;
        for (const file of items) {
          try {
            await saveLocalTextFile({
              fileName: file.fileName || "local-text.txt",
              sizeBytes: Number(file.sizeBytes || 0),
              lastModified: Number(file.lastModified || 0),
              encoding: file.encoding,
              text: file.text,
              sourceUri: file.uri || "",
              sourceType: "system-picker"
            });
            imported += 1;
            setStatus?.(` + "`文件管理器导入 ${formatNumber(imported)}/${formatNumber(items.length)}：${file.fileName || \"TXT\"}`" + String.raw`);
          } catch (error) {
            skipped += 1;
            setStatus?.(` + "`已跳过 ${formatNumber(skipped)} 本导入失败的 TXT：${file.fileName || \"TXT\"}`" + String.raw`);
          }
        }

        clearNovelBusy();
        focusLocalLibraryAfterImport();
        setStatus?.(skipped || errors.length
          ? ` + "`已导入 ${formatNumber(imported)} 本，跳过 ${formatNumber(skipped + errors.length)} 个文件`" + String.raw`
          : ` + "`已从文件管理器导入 ${formatNumber(imported)} 本`" + String.raw`);
        renderCurrentView();
      })
      .catch((error) => {
        clearNovelBusy();
        setStatus?.(` + "`文件管理器导入失败：${error.message || error}`" + String.raw`, "error");
        renderCurrentView();
      });
  }`
};
