export function openMusicQueuePositionDialog({ track, trigger, getQueue, getCurrentId, isCurrent, move, formatNumber }) {
  const panel = trigger.closest(".music-queue");
  const queue = getQueue();
  const from = queue.findIndex(item => item.id === track.id);
  if (!panel || from < 0 || queue.length < 2 || panel.querySelector(".music-queue-position-dialog")) return;

  const dialog = document.createElement("dialog");
  dialog.className = "music-queue-position-dialog";
  dialog.setAttribute("aria-labelledby", "music-queue-position-title");
  const form = document.createElement("form");
  const title = document.createElement("h2");
  title.id = "music-queue-position-title";
  title.textContent = "调整队列位置";
  const caption = document.createElement("p");
  caption.className = "music-queue-position-track";
  caption.textContent = track.title || "歌曲";
  const field = document.createElement("label");
  field.textContent = `队列位置（1–${formatNumber(queue.length)}）`;
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.value = String(from + 1);
  field.append(input);
  const status = document.createElement("p");
  status.id = "music-queue-position-error";
  status.className = "music-queue-position-error";
  status.setAttribute("role", "alert");
  input.setAttribute("aria-describedby", status.id);

  const controls = document.createElement("div");
  controls.className = "music-queue-position-presets";
  const nextToCurrent = () => {
    const index = queue.findIndex(item => item.id === getCurrentId());
    return index < 0 || index === from ? null : index + (from > index ? 2 : 1);
  };
  const clearError = () => {
    input.removeAttribute("aria-invalid");
    status.textContent = "";
  };
  for (const [label, position] of [["队首", () => 1], ["当前曲后", nextToCurrent], ["队尾", () => queue.length]]) {
    const preset = document.createElement("button");
    preset.type = "button";
    preset.textContent = label;
    preset.disabled = position() === null;
    preset.addEventListener("click", () => {
      const value = position();
      if (value === null) return;
      input.value = String(value);
      clearError();
    });
    controls.append(preset);
  }
  const footer = document.createElement("div");
  footer.className = "music-queue-position-footer";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  const confirm = document.createElement("button");
  confirm.type = "submit";
  confirm.textContent = "移动";
  footer.append(cancel, confirm);
  form.append(title, caption, field, controls, status, footer);
  dialog.append(form);

  const remove = () => {
    if (!dialog.isConnected) return;
    dialog.remove();
    if (trigger.isConnected && isCurrent() && document.activeElement === document.body) trigger.focus({ preventScroll: true });
  };
  const close = () => { dialog.close(); remove(); };
  cancel.addEventListener("click", close);
  dialog.addEventListener("close", remove, { once: true });
  dialog.addEventListener("keydown", event => event.stopPropagation());
  input.addEventListener("input", clearError);
  let composing = false;
  input.addEventListener("compositionstart", () => { composing = true; });
  input.addEventListener("compositionend", () => { composing = false; });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (!dialog.open || composing) return;
    if (!trigger.isConnected || !isCurrent() || getQueue() !== queue) {
      status.textContent = "队列已变化，请关闭后重新选择位置。";
      return;
    }
    const value = input.value.normalize("NFKC").trim();
    const position = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(position) || position < 1 || position > queue.length) {
      input.setAttribute("aria-invalid", "true");
      status.textContent = `请输入 1 到 ${formatNumber(queue.length)} 之间的整数。`;
      input.focus({ preventScroll: true });
      return;
    }
    const offset = position - 1 - from;
    close();
    if (offset) {
      move(offset);
      const focused = document.activeElement;
      if (focused?.closest(".music-queue-row")?.dataset.musicTrackId === String(track.id)) {
        focused.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      }
    }
  });
  panel.append(dialog);
  dialog.showModal();
  input.focus({ preventScroll: true });
  input.select();
}
