const STORAGE_PREFIX = "fanhao.player.bookmarks.v1:";
const MAX_BOOKMARKS = 50;
const MAX_NOTE_LENGTH = 80;

function positionMillis(seconds) {
  const value = Math.round(seconds * 1000);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function bookmarkKey({ owner, source }) {
  return STORAGE_PREFIX + JSON.stringify([owner, source]);
}

function sameBookmark(left, right) {
  return left.at === right.at && left.note === right.note;
}

function readBookmarks(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("书签记录格式无效");
  return data.filter(mark => mark && Number.isSafeInteger(mark.at) && mark.at >= 0
    && typeof mark.note === "string" && mark.note.length <= MAX_NOTE_LENGTH);
}

export function createPlayerBookmarks({ button, dialog, getContext, seek, formatTime }) {
  if (!button || !dialog) return { open() {}, setAvailable() {} };
  const form = dialog.querySelector("form");
  const input = form.querySelector("input");
  const save = form.querySelector('[type="submit"]');
  const capture = dialog.querySelector("[data-bookmark-capture]");
  const position = dialog.querySelector("[data-bookmark-position]");
  const file = dialog.querySelector("[data-bookmark-file]");
  const status = dialog.querySelector("[data-bookmark-status]");
  const list = dialog.querySelector("ul");
  const empty = dialog.querySelector("[data-bookmark-empty]");
  let current = null;
  let composing = false;
  input.maxLength = MAX_NOTE_LENGTH;

  function liveContext() {
    if (!current || button.disabled || !dialog.open || !dialog.isConnected) return null;
    const context = getContext();
    return context && context.revision === current.revision && bookmarkKey(context) === current.key ? context : null;
  }

  function timeLabel(at) {
    const seconds = Math.floor(at / 1000);
    const fraction = at % 1000;
    return formatTime(seconds) + (fraction ? `.${String(fraction).padStart(3, "0").replace(/0+$/u, "")}` : "");
  }

  function updatePosition(seconds) {
    current.at = Number.isFinite(seconds) ? positionMillis(seconds) : null;
    save.disabled = current.at === null;
    position.textContent = current.at === null ? "正在准备播放位置" : `取点 ${timeLabel(current.at)}`;
  }

  function renderList(marks) {
    const owner = current;
    const rows = marks.slice().sort((left, right) => left.at - right.at).map(mark => {
      const row = document.createElement("li");
      const jump = document.createElement("button");
      const remove = document.createElement("button");
      const time = timeLabel(mark.at);
      const label = mark.note ? `${time} · ${mark.note}` : time;
      jump.type = remove.type = "button";
      jump.textContent = label;
      jump.setAttribute("aria-label", `跳到 ${label}`);
      remove.textContent = "删除";
      remove.setAttribute("aria-label", `删除 ${label} 书签`);
      jump.addEventListener("click", () => {
        if (owner !== current || !row.isConnected) return;
        const live = liveContext();
        if (!live) return;
        if (live.duration > 0 && mark.at > positionMillis(live.duration)) {
          status.textContent = "书签超出当前视频时长";
          return;
        }
        seek(mark.at / 1000);
        dialog.close();
      });
      remove.addEventListener("click", () => {
        if (owner !== current || !row.isConnected || !liveContext()) return;
        try {
          const fresh = readBookmarks(owner.key);
          const index = fresh.findIndex(item => sameBookmark(item, mark));
          if (index >= 0) {
            fresh.splice(index, 1);
            if (fresh.length) localStorage.setItem(owner.key, JSON.stringify(fresh));
            else localStorage.removeItem(owner.key);
          }
          renderList(fresh);
          (list.querySelector("button") || input).focus({ preventScroll: true });
          status.textContent = "已移除书签";
        } catch {
          status.textContent = "无法移除书签，请检查浏览器存储";
        }
      });
      row.append(jump, remove);
      return row;
    });
    list.replaceChildren(...rows);
    empty.hidden = Boolean(rows.length);
  }

  function open() {
    if (button.disabled || document.querySelector("dialog[open], .player-move-dialog")) return;
    const context = getContext();
    if (!context) return;
    current = { key: bookmarkKey(context), revision: context.revision, at: null };
    file.textContent = context.title ? `${context.title} · 保存在此浏览器` : "保存在此浏览器";
    input.value = "";
    status.textContent = "";
    composing = false;
    updatePosition(context.position);
    try { renderList(readBookmarks(current.key)); }
    catch {
      renderList([]);
      status.textContent = "无法读取本机书签";
    }
    dialog.showModal();
    input.focus({ preventScroll: true });
  }

  form.addEventListener("compositionstart", () => { composing = true; });
  form.addEventListener("compositionend", () => { composing = false; });
  form.addEventListener("keydown", event => {
    if (event.key === "Enter" && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (composing || !liveContext() || current.at === null) return;
    const note = input.value.trim().slice(0, MAX_NOTE_LENGTH).toWellFormed();
    const mark = { at: current.at, note };
    try {
      const marks = readBookmarks(current.key);
      if (marks.some(item => sameBookmark(item, mark))) {
        status.textContent = "这个时间和备注已保存";
        return;
      }
      if (marks.length >= MAX_BOOKMARKS) {
        status.textContent = `每个视频最多保存 ${MAX_BOOKMARKS} 个书签`;
        return;
      }
      marks.push(mark);
      localStorage.setItem(current.key, JSON.stringify(marks));
      renderList(marks);
      input.value = "";
      status.textContent = `已保存 ${timeLabel(mark.at)} 的书签`;
    } catch {
      status.textContent = "无法保存书签，请检查浏览器存储";
    }
  });
  capture.addEventListener("click", () => {
    const context = liveContext();
    if (!context) return;
    updatePosition(context.position);
    status.textContent = "";
  });
  dialog.querySelector("[data-bookmark-close]").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { if (!dialog.open) current = null; });
  button.addEventListener("click", open);

  function setAvailable(available) {
    button.disabled = !available;
    if (!available) {
      current = null;
      dialog.close();
    }
  }

  return { open, setAvailable };
}
