import { formatNumber } from "../../js/format.js";
import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=assets-78764ed05056";

export function openMusicQueuePosition({ trigger, track, queue, currentId, isCurrent, move }) {
  const from = queue.indexOf(track);
  if (from < 0 || queue.length < 2) return null;

  const sheet = openMobileActionSheet({ title: "移动到位置", trigger });
  sheet.panel.classList.add("music-mobile-queue-position-sheet");
  const summary = document.createElement("p");
  summary.className = "music-mobile-queue-position-track";
  summary.textContent = `${track.title || "歌曲"} · 第 ${formatNumber(from + 1)} 首`;

  const presets = document.createElement("div");
  presets.className = "music-mobile-queue-position-presets";
  const current = queue.findIndex(item => item.id === currentId);
  const afterCurrent = current >= 0 && current !== from ? current + (from > current ? 1 : 0) : -1;
  for (const [label, index] of [["移到队首", 0], ["移到当前曲后", afterCurrent], ["移到队尾", queue.length - 1]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = index < 0 || index === from;
    button.addEventListener("click", () => choose(index));
    presets.append(button);
  }

  const form = document.createElement("form");
  const label = document.createElement("label");
  label.htmlFor = "musicQueuePosition";
  label.textContent = `队列位置（1–${formatNumber(queue.length)}）`;
  const input = document.createElement("input");
  input.id = label.htmlFor;
  input.inputMode = "numeric";
  input.enterKeyHint = "go";
  input.autocomplete = "off";
  input.maxLength = 16;
  input.setAttribute("aria-describedby", "musicQueuePositionStatus");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "移动";
  const status = document.createElement("p");
  status.id = "musicQueuePositionStatus";
  status.setAttribute("role", "status");
  form.append(label, input, submit, status);
  sheet.panel.append(summary, presets, form);

  function choose(index) {
    if (!sheet.overlay.isConnected) return;
    if (!isCurrent()) {
      status.textContent = "队列已变化，请关闭后重新选择位置。";
      return;
    }
    if (sheet.close() && index !== from) move(index - from);
  }

  let composing = false;
  let confirmingCandidate = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter" || !(composing || event.isComposing || event.keyCode === 229)) return;
    confirmingCandidate = true;
    setTimeout(() => { confirmingCandidate = false; }, 0);
  });
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    status.textContent = "";
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (composing || confirmingCandidate || !sheet.overlay.isConnected) return;
    const value = input.value.normalize("NFKC").trim();
    const position = /^\d+$/u.test(value) ? Number(value) : 0;
    if (!Number.isSafeInteger(position) || position < 1 || position > queue.length) {
      input.setAttribute("aria-invalid", "true");
      status.textContent = `请输入 1–${formatNumber(queue.length)} 之间的整数。`;
      input.focus({ preventScroll: true });
      return;
    }
    choose(position - 1);
  });
  sheet.panel.addEventListener("keydown", event => {
    if (event.key !== "Tab" || document.activeElement !== (event.shiftKey ? sheet.closeButton : submit)) return;
    event.preventDefault();
    (event.shiftKey ? submit : sheet.closeButton).focus();
  });
  return sheet;
}
