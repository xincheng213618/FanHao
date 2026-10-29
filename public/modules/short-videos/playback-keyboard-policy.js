const playbackShortcutKeys = new Set([
  "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "PageDown", "PageUp",
  " ", "m", "M", "j", "J", "f", "F", "Escape"
]);

const reservedTargetSelector = [
  "input", "textarea", "select", "[contenteditable]:not([contenteditable='false'])",
  "[role='textbox']", "[role='searchbox']", "[role='combobox']", "[role='spinbutton']",
  "[role='slider']", "[role='menu']", "[role='menubar']", "[role='listbox']",
  "[role='tree']", "[role='tablist']", "[role='tab']", "[role='radiogroup']",
  "[role='dialog']"
].join(",");

const activationTargetSelector = "button, a, summary, [role='button'], [role='checkbox'], [role='switch'], [role='radio']";

export function shouldHandleShortVideoShortcut(event) {
  if (!playbackShortcutKeys.has(event?.key)
    || event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.altKey || event.metaKey) return false;
  if (event.shiftKey && !/^[mMjJfF]$/.test(event.key)) return false;

  const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
  if (target?.isContentEditable || target?.closest?.(reservedTargetSelector)) return false;
  // Native button activation runs on keyup. Handling Space here as well would
  // pause a video and activate the focused navigation/mute button in one press.
  if (event.key === " " && target?.closest?.(activationTargetSelector)) return false;
  return true;
}
