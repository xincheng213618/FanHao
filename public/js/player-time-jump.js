export function parsePlaybackTimeInput(value) {
  const parts = String(value ?? "").trim().replaceAll("：", ":").split(":");
  if (parts.length > 3 || !parts.every((part, index) => (index === parts.length - 1 ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(part))) return null;
  if (parts.length > 1 && Number(parts.at(-1)) >= 60) return null;
  if (parts.length === 3 && Number(parts[1]) >= 60) return null;
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  return Number.isSafeInteger(Math.floor(seconds)) && seconds >= 0 ? seconds : null;
}

// The host retains playback/source ownership; this control only accepts a time.
export function createPlaybackTimeJumpControl({ button, getPosition, seek, formatTime }) {
  let available = false, revision = 0, dialog = null;
  function open() {
    if (!available || dialog?.open || document.querySelector("dialog[open], .player-move-dialog")) return;
    const snapshot = getPosition();
    if (!snapshot) return;
    const owner = revision;
    const current = document.createElement("dialog");
    current.className = "player-utility-dialog player-time-jump-dialog";
    current.setAttribute("aria-labelledby", "playerTimeJumpTitle");
    const title = document.createElement("h2");
    title.id = "playerTimeJumpTitle";
    title.textContent = "跳到时间";
    const note = document.createElement("p");
    note.id = "playerTimeJumpNote";
    note.textContent = `当前位置 ${formatTime(snapshot.position)}${snapshot.duration > 0 ? `，总时长 ${formatTime(snapshot.duration)}` : ""}。支持秒数、分:秒或时:分:秒，可输入小数秒。`;
    const form = document.createElement("form");
    form.noValidate = true;
    const label = document.createElement("label");
    label.textContent = "播放位置";
    const input = document.createElement("input");
    input.type = "text";
    input.value = String(Math.round(snapshot.position * 1000) / 1000);
    input.placeholder = "例如 1:23.5 或 90";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-describedby", note.id);
    label.append(input);
    const error = document.createElement("p");
    error.id = "playerTimeJumpError";
    error.className = "player-time-jump-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    input.setAttribute("aria-errormessage", error.id);
    const actions = document.createElement("div");
    actions.className = "player-time-jump-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "跳转";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => current.close());
    let composing = false;
    input.addEventListener("compositionstart", () => { composing = true; });
    input.addEventListener("compositionend", () => { composing = false; });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
    });
    input.addEventListener("input", () => { error.hidden = true; input.removeAttribute("aria-invalid"); });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (composing || owner !== revision || !available || !current.isConnected || !current.open) return;
      const position = getPosition();
      if (!position) return;
      const target = parsePlaybackTimeInput(input.value);
      const message = target === null ? "请输入有效时间，例如 1:23.5 或 90。"
        : position.duration > 0 && target > position.duration ? `请输入 0:00 至 ${formatTime(position.duration)} 之间的位置。` : "";
      if (message) {
        error.textContent = message;
        error.hidden = false;
        input.setAttribute("aria-invalid", "true");
        input.focus();
        return;
      }
      seek(target);
      current.close();
    });
    actions.append(submit, cancel);
    form.append(label, error, actions);
    current.append(title, note, form);
    current.addEventListener("close", () => { current.remove(); if (dialog === current) dialog = null; });
    document.body.append(current);
    dialog = current;
    current.showModal();
    input.focus();
    input.select();
  }
  button?.addEventListener("click", open);
  return {
    open,
    setAvailable(value) { available = Boolean(value); if (button) button.disabled = !available; },
    invalidate() { revision++; available = false; if (button) button.disabled = true; dialog?.close(); }
  };
}
