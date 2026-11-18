import { formatNumber } from "../../js/format.js";
import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=assets-78764ed05056";

export function openPhotoResumeHistory({ trigger, isCurrent, read, discard, open, onChange }) {
  const sheet = openMobileActionSheet({ title: "套图浏览记录", trigger });
  sheet.panel.classList.add("photo-resume-history");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "搜索套图名称";
  search.setAttribute("aria-label", "搜索套图浏览记录");
  const status = document.createElement("div");
  status.setAttribute("role", "status");
  const list = document.createElement("ul");
  sheet.panel.append(search, status, list);

  const current = () => sheet.overlay.isConnected && isCurrent();
  const normalize = value => value.normalize("NFKC").toLocaleLowerCase();
  let composing = false;

  function render(message = "") {
    const all = read();
    const query = normalize(search.value.trim());
    const matches = all.filter(record => normalize(record.title).includes(query));
    status.textContent = message || (matches.length ? `${formatNumber(matches.length)} 条浏览记录`
      : all.length ? "没有匹配的套图" : "暂无套图浏览记录");
    const fragment = document.createDocumentFragment();
    for (const [index, record] of matches.entries()) {
      const item = document.createElement("li");
      const resume = document.createElement("button");
      resume.type = "button";
      resume.className = "photo-resume-history-open";
      const title = document.createElement("strong");
      title.textContent = record.title;
      const position = document.createElement("small");
      position.textContent = `第 ${formatNumber(record.page)} 张`;
      resume.append(title, position);
      resume.addEventListener("click", () => {
        if (!current() || !resume.isConnected) return;
        if (!read().some(item => item.id === record.id && item.page === record.page && item.revision === record.revision)) {
          render("浏览位置已更新，请重新选择");
          search.focus({ preventScroll: true });
          return;
        }
        sheet.close(false);
        open(record);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "photo-resume-history-remove";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `移除「${record.title}」的浏览记录`);
      remove.addEventListener("click", () => {
        if (!current() || !remove.isConnected) return;
        if (!discard(record)) {
          status.textContent = "无法移除这条浏览记录，请重新打开后重试";
          return;
        }
        const focused = document.activeElement === remove;
        onChange();
        render(`已移除浏览记录 · 剩余 ${formatNumber(read().length)} 条`);
        if (focused) {
          const buttons = list.querySelectorAll(".photo-resume-history-remove");
          (buttons[Math.min(index, buttons.length - 1)] || search).focus({ preventScroll: true });
        }
      });
      item.append(resume, remove);
      fragment.append(item);
    }
    list.replaceChildren(fragment);
  }

  const applySearch = () => { if (current() && !composing) { list.scrollTop = 0; render(); } };
  search.addEventListener("input", applySearch);
  search.addEventListener("compositionstart", () => { composing = true; });
  search.addEventListener("compositionend", () => { composing = false; applySearch(); });
  sheet.panel.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const last = list.lastElementChild?.lastElementChild || search;
    if (document.activeElement !== (event.shiftKey ? sheet.closeButton : last)) return;
    event.preventDefault();
    (event.shiftKey ? last : sheet.closeButton).focus();
  });
  render();
}
