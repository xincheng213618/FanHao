import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=assets-06c1d7f13464";

const STORAGE_PREFIX = "fanhao.android.novelReadLater.v1:";
const LIMIT = 100;
const PAGE_SIZE = 8;

export function readNovelReadLater(scope) {
  let payload;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + scope.key);
    if (!raw) return [];
    payload = JSON.parse(raw);
  } catch { throw new Error("无法读取待读清单，请检查浏览器存储"); }
  if (payload?.version !== 1 || !Array.isArray(payload.books)) throw new Error("无法读取待读清单，请检查浏览器存储");
  const books = new Map();
  for (const book of payload.books) {
    if (!scope.matchesId(book?.id) || books.has(book.id) || typeof book.title !== "string" || typeof book.author !== "string") continue;
    books.set(book.id, { id: book.id, title: book.title.slice(0, 200), author: book.author.slice(0, 120) });
    if (books.size === LIMIT) break;
  }
  return [...books.values()];
}

function writeNovelReadLater(scope, books) {
  try { localStorage.setItem(STORAGE_PREFIX + scope.key, JSON.stringify({ version: 1, books })); }
  catch { throw new Error("无法保存待读清单，请检查浏览器存储"); }
}

export function toggleNovelReadLater(scope, book) {
  if (!scope.isCurrent() || !scope.matchesId(book?.id)) throw new Error("书库已切换，请重新操作");
  const books = readNovelReadLater(scope);
  const saved = books.some(entry => entry.id === book.id);
  if (saved) writeNovelReadLater(scope, books.filter(entry => entry.id !== book.id));
  else {
    if (books.length >= LIMIT) throw new Error(`待读清单已满，最多保存 ${LIMIT} 本`);
    const entry = { id: book.id, title: String(book.title || book.id).slice(0, 200), author: String(book.author || "").slice(0, 120) };
    writeNovelReadLater(scope, [entry, ...books]);
  }
  return !saved;
}

export function openNovelReadLater({ scope, trigger, getTrigger, openBook }) {
  if (!scope.isCurrent() || !trigger.isConnected) return;
  const sheet = openMobileActionSheet({ title: scope.title, trigger: () => trigger.isConnected ? trigger : getTrigger() });
  const body = document.createElement("div");
  body.className = "novel-mobile-read-later-list";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "搜索书名或作者";
  search.setAttribute("aria-label", "搜索待读清单");
  const list = document.createElement("ul");
  const more = button("显示更多");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  body.append(search, list, more, status);
  sheet.panel.append(body);
  let limit = PAGE_SIZE;
  let composing = false;
  const ownsSheet = () => sheet.overlay.isConnected && scope.isCurrent();
  const normalize = value => value.normalize("NFKC").trim().toLocaleLowerCase();
  function render() {
    list.replaceChildren();
    more.hidden = true;
    let books;
    try { books = readNovelReadLater(scope); }
    catch { status.textContent = "无法读取待读清单，请检查浏览器存储"; return; }
    const query = normalize(search.value);
    const matches = books.filter(book => !query || normalize(`${book.title} ${book.author}`).includes(query));
    search.hidden = !books.length && !query;
    status.textContent = matches.length ? "" : query ? "没有匹配的待读小说" : "还没有待读小说";
    for (const [index, book] of matches.slice(0, limit).entries()) {
      const row = document.createElement("li");
      const open = button(book.title);
      open.className = "novel-mobile-read-later-open";
      const author = document.createElement("small");
      author.textContent = book.author;
      open.append(author);
      open.addEventListener("click", () => {
        if (!open.isConnected || !ownsSheet()) return;
        sheet.close(false);
        openBook(book);
      });
      const remove = button("移除");
      remove.className = "novel-mobile-read-later-remove";
      remove.setAttribute("aria-label", `从待读移除 ${book.title}`);
      remove.addEventListener("click", () => {
        if (!remove.isConnected || !ownsSheet()) return;
        try {
          const focused = document.activeElement === remove;
          writeNovelReadLater(scope, readNovelReadLater(scope).filter(entry => entry.id !== book.id));
          render();
          if (focused) {
            const controls = list.querySelectorAll(".novel-mobile-read-later-remove");
            (controls[Math.min(index, controls.length - 1)] || (search.hidden ? sheet.closeButton : search)).focus({ preventScroll: true });
          }
        } catch { status.textContent = "移除失败，待读记录仍保留"; }
      });
      row.append(open, remove);
      list.append(row);
    }
    more.hidden = matches.length <= limit;
  }
  function applySearch() {
    if (composing || !ownsSheet()) return;
    limit = PAGE_SIZE;
    render();
  }
  search.addEventListener("compositionstart", () => { composing = true; });
  search.addEventListener("compositionend", () => { composing = false; applySearch(); });
  search.addEventListener("input", applySearch);
  more.addEventListener("click", () => {
    if (!ownsSheet()) return;
    const focused = document.activeElement === more;
    const firstNew = limit;
    limit += PAGE_SIZE;
    render();
    if (focused) (more.hidden ? list.children[firstNew]?.firstElementChild : more)?.focus({ preventScroll: true });
  });
  render();
  return sheet;
}

function button(label) {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  return node;
}
