import { captureWebAccount } from "../../platform/accounts/session-context.js";

const NOVEL_BOOKMARK_LIMIT = 50;

export function createNovelBookmarksPanel({ book, chapter, isCurrent, getRatio, openBookmark }) {
  const panel = document.createElement("section");
  panel.className = "novel-bookmarks";
  panel.setAttribute("aria-label", "本机书签");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const list = document.createElement("ul");
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  message.textContent = "保存在当前浏览器，每本最多 50 个。";
  const save = chapter ? document.createElement("button") : null;
  if (save) {
    save.type = "button";
    save.className = "novel-secondary-button";
    save.textContent = "保存当前位置书签";
    save.dataset.readerFocus = "bookmark-save";
    panel.append(save);
  }
  details.append(summary, list);
  panel.append(details, message);
  let account;
  try { account = captureWebAccount(); }
  catch { message.textContent = "账号已切换，请刷新后查看本机书签。"; if (save) save.disabled = true; return panel; }
  const supported = Boolean(book?.id && book.sourceRealm && book.catalogRevision && (!chapter || chapter.id));
  if (!supported) {
    summary.textContent = "本机书签";
    message.textContent = "当前书籍缺少稳定标识，暂时无法保存书签。";
    if (save) save.disabled = true;
    return panel;
  }
  const key = `fanhao.novel.bookmarks.v1:${JSON.stringify([account.owner || "guest", book.sourceRealm, String(book.id)])}`;
  const current = () => {
    try {
      const latest = captureWebAccount();
      return panel.isConnected && isCurrent() && latest.owner === account.owner && latest.revision === account.revision;
    } catch { return false; }
  };
  const read = () => {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.items)) throw new Error("无法读取本机书签，请检查浏览器存储后重试。");
    const items = [], seen = new Set();
    for (const item of data.items) {
      if (!item || typeof item.id !== "string" || !item.id.trim() || item.id.length > 80 || seen.has(item.id)
        || typeof item.chapterId !== "string" || !item.chapterId || item.chapterId.length > 200
        || typeof item.catalogRevision !== "string" || !item.catalogRevision || item.catalogRevision.length > 200
        || !Number.isSafeInteger(item.chapterIndex) || item.chapterIndex <= 0 || !Number.isFinite(item.ratio) || item.ratio < 0 || item.ratio > 1
        || typeof item.title !== "string") continue;
      seen.add(item.id);
      items.push({ id: item.id, chapterId: item.chapterId, catalogRevision: item.catalogRevision, chapterIndex: item.chapterIndex, title: item.title.slice(0, 160), ratio: item.ratio });
      if (items.length >= NOVEL_BOOKMARK_LIMIT) break;
    }
    return items;
  };
  const write = items => localStorage.setItem(key, JSON.stringify({ version: 1, items }));
  const fail = () => { message.textContent = "无法保存或读取本机书签，请检查浏览器存储空间与权限后重试。"; };
  const render = items => {
    summary.textContent = `本机书签（${items.length}）`;
    list.textContent = "";
    if (!items.length) { const empty = document.createElement("li"); empty.textContent = "阅读正文时可保存当前位置。"; list.append(empty); }
    for (const [index, item] of items.entries()) {
      const row = document.createElement("li");
      row.className = "novel-bookmark-row";
      const label = `${item.title.slice(0, 160)} · ${Math.round(item.ratio * 10000) / 100}%`;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "novel-bookmark-open";
      open.textContent = label;
      open.setAttribute("aria-label", `打开书签：${label}`);
      open.disabled = item.catalogRevision !== book.catalogRevision;
      open.addEventListener("click", () => {
        try {
          if (!open.isConnected || !current() || open.disabled) return;
          Promise.resolve(openBookmark(item, document.activeElement === open)).catch(() => { if (current()) message.textContent = "书签打开失败，请重试。"; });
        } catch { fail(); }
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "novel-bookmark-remove";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `移除书签：${label}`);
      remove.addEventListener("click", () => {
        try {
          if (!remove.isConnected || !current()) return;
          const focused = document.activeElement === remove;
          const items = read().filter(mark => mark.id !== item.id);
          write(items); render(items);
          message.textContent = "已移除本机书签。";
          if (focused) {
            const next = list.querySelectorAll(".novel-bookmark-remove");
            (next[Math.min(index, next.length - 1)] || save || summary).focus({ preventScroll: true });
          }
        } catch { fail(); }
      });
      row.append(open, remove);
      if (open.disabled) {
        const stale = document.createElement("span");
        stale.textContent = "目录已更新，旧书签不可定位";
        row.append(stale);
      }
      list.append(row);
    }
  };
  save?.addEventListener("click", () => {
    try {
      if (!current()) return;
      const items = read(), ratio = getRatio();
      if (items.some(item => item.catalogRevision === book.catalogRevision && item.chapterId === chapter.id && Math.abs(item.ratio - ratio) < .000001)) {
        message.textContent = "这个位置已在本机书签中。"; return;
      }
      if (items.length >= NOVEL_BOOKMARK_LIMIT) { message.textContent = "本书已有 50 个本机书签，请先移除不再需要的书签。"; return; }
      const item = { id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        catalogRevision: book.catalogRevision, chapterId: chapter.id, chapterIndex: Number(chapter.index),
        title: String(chapter.title || `第 ${chapter.index} 章`).slice(0, 160), ratio };
      const next = [item, ...items];
      write(next); render(next); details.open = true;
      message.textContent = "已保存当前位置的本机书签。";
    } catch { fail(); }
  });
  try { render(read()); } catch { summary.textContent = "本机书签"; fail(); }
  return panel;
}
