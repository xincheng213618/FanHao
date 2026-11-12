const STORAGE_PREFIX = "fanhao.android.novelBookmarks.v1:";
const LIMIT = 30;

export function mountNovelBookmarks({ sheet, key, revision, chapter, isCurrent, getRatio, openMark }) {
  const body = document.createElement("div");
  body.className = "novel-reader-bookmarks";
  const save = button("保存当前位置");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const list = document.createElement("ul");
  body.append(save, status, list);
  sheet.panel.append(body);
  const active = () => sheet.overlay.isConnected && isCurrent();
  const storageKey = STORAGE_PREFIX + key;

  function render(items) {
    list.replaceChildren();
    for (const [index, mark] of items.entries()) {
      const row = document.createElement("li");
      const label = `${mark.title} · ${Math.round(mark.ratio * 10000) / 100}%`;
      const open = button(mark.revision === revision ? label : `${label}（旧版本）`);
      open.className = "novel-bookmark-open";
      open.disabled = mark.revision !== revision;
      open.addEventListener("click", () => {
        if (!active() || !open.isConnected || open.disabled) return;
        const sameChapter = mark.chapterId === chapter.id && mark.chapterIndex === Number(chapter.index);
        if (sheet.close(sameChapter)) openMark(mark);
      });
      const remove = button("移除");
      remove.className = "novel-bookmark-remove";
      remove.setAttribute("aria-label", `移除书签 ${label}`);
      remove.addEventListener("click", () => {
        if (!active() || !remove.isConnected) return;
        try {
          const latest = readMarks(storageKey).filter(item => !sameMark(item, mark));
          localStorage.setItem(storageKey, JSON.stringify(latest));
          render(latest);
          status.textContent = "已移除书签";
          const controls = list.querySelectorAll(".novel-bookmark-remove");
          (controls[Math.min(index, controls.length - 1)] || save).focus({ preventScroll: true });
        } catch { status.textContent = "书签移除失败，请检查手机存储"; }
      });
      row.append(open, remove);
      list.append(row);
    }
    if (!items.length) status.textContent = "还没有书签";
  }

  save.addEventListener("click", () => {
    if (!active()) return;
    try {
      const items = readMarks(storageKey);
      const mark = { chapterId: chapter.id, chapterIndex: Number(chapter.index), revision,
        title: String(chapter.title || `第 ${chapter.index} 章`).slice(0, 160), ratio: getRatio() };
      if (items.some(item => sameMark(item, mark))) { status.textContent = "当前位置已保存"; return; }
      if (items.length >= LIMIT) { status.textContent = `每本书最多保留 ${LIMIT} 个书签，请先移除旧书签`; return; }
      const next = [mark, ...items];
      localStorage.setItem(storageKey, JSON.stringify(next));
      render(next);
      status.textContent = "已保存当前位置";
    } catch { status.textContent = "书签保存失败，请检查手机存储"; }
  });
  try { render(readMarks(storageKey)); }
  catch { status.textContent = "书签读取失败，请检查手机存储"; }
}

function readMarks(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) return [];
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) throw new Error("Invalid bookmark list");
  return items.slice(0, LIMIT).filter(item => item && typeof item.chapterId === "string" && item.chapterId.length > 0 && item.chapterId.length <= 500
    && typeof item.revision === "string" && item.revision.length > 0 && item.revision.length <= 500
    && Number.isSafeInteger(item.chapterIndex) && item.chapterIndex > 0
    && Number.isFinite(item.ratio) && item.ratio >= 0 && item.ratio <= 1 && typeof item.title === "string")
    .map(({ chapterId, chapterIndex, revision, title, ratio }) => ({ chapterId, chapterIndex, revision, title: title.slice(0, 160), ratio }));
}

function sameMark(left, right) {
  return left.chapterId === right.chapterId && left.chapterIndex === right.chapterIndex
    && left.revision === right.revision && Math.abs(left.ratio - right.ratio) < 0.000001;
}

function button(label) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  return node;
}
