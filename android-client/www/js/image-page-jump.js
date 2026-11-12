export function createImagePageJump({ getPageCount, onJump, isCurrent = () => true }) {
  const form = document.createElement("form");
  form.className = "image-page-jump";
  const input = document.createElement("input");
  input.inputMode = "numeric";
  input.enterKeyHint = "go";
  input.autocomplete = "off";
  input.maxLength = 16;
  input.placeholder = "图片页码";
  input.setAttribute("aria-label", "图片页码");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "跳转";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  form.append(input, submit, status);

  let busy = false;
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
    if (busy) return;
    status.textContent = "";
    input.removeAttribute("aria-invalid");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || composing || confirmingCandidate || !form.isConnected || !isCurrent()) return;
    const value = input.value.normalize("NFKC").trim();
    const page = /^\d+$/u.test(value) ? Number(value) : 0;
    const count = getPageCount();
    if (!Number.isSafeInteger(page) || page < 1 || page > count) {
      input.setAttribute("aria-invalid", "true");
      status.textContent = `请输入 1–${count} 之间的页码。`;
      input.focus({ preventScroll: true });
      return;
    }

    input.removeAttribute("aria-invalid");
    status.textContent = "";
    busy = true;
    input.readOnly = true;
    submit.setAttribute("aria-disabled", "true");
    try {
      const result = onJump(page, submit);
      if (result?.then) status.textContent = "正在定位图片…";
      const opened = await result;
      if (form.isConnected && isCurrent()) {
        status.textContent = "";
        if (opened) input.value = "";
      }
    } catch (error) {
      if (form.isConnected && isCurrent()) status.textContent = error.message || "图片定位失败，请重试。";
    } finally {
      busy = false;
      input.readOnly = false;
      submit.removeAttribute("aria-disabled");
    }
  });
  return { form, input, status };
}
