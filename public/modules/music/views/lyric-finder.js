// Current-song text lookup only. The owner supplies viewport and seek behavior;
// this controller never changes playback, navigation, or requests library data.
export function createLyricFinder({ state, lines, isCurrent, onLocate, onChange, canSeek = true }) {
  const element = document.createElement("div");
  element.className = "music-lyric-find";
  const input = document.createElement("input");
  input.type = "search";
  input.placeholder = "查找当前歌词";
  input.setAttribute("aria-label", "查找当前歌词");
  input.title = canSeek ? "查找并定位歌词，点击歌词可跳转播放位置" : "查找并定位纯文本歌词，不改变播放位置";
  input.value = state.query;
  const previous = document.createElement("button");
  previous.type = "button";
  previous.textContent = "↑";
  previous.setAttribute("aria-label", "上一处歌词");
  const next = document.createElement("button");
  next.type = "button";
  next.textContent = "↓";
  next.setAttribute("aria-label", "下一处歌词");
  const count = document.createElement("span");
  count.className = "music-lyric-find-count";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  let composing = false;

  function updateControls() {
    previous.disabled = next.disabled = !state.matches.length;
    count.textContent = !state.needle ? "输入文字查找" : state.matches.length ? `${state.cursor + 1} / ${state.matches.length}` : "无匹配";
    count.title = state.matches.length ? `${state.matches.length} 行匹配歌词` : count.textContent;
  }
  function locate(delta) {
    if (!isCurrent() || !state.matches.length) return;
    state.cursor = (state.cursor + delta + state.matches.length) % state.matches.length;
    updateControls();
    onLocate(state.matches[state.cursor]);
  }
  function acceptInput() {
    if (!isCurrent() || composing) return;
    const query = input.value, needle = query.trim().toLocaleLowerCase();
    state.query = query;
    if (needle === state.needle) return;
    state.needle = needle;
    state.matches = [];
    if (needle) for (let index = 0; index < lines.length; index++) {
      if (String(lines[index].text || "").toLocaleLowerCase().includes(needle)) state.matches.push(index);
    }
    state.matchSet = new Set(state.matches);
    state.cursor = state.matches.length ? 0 : -1;
    updateControls();
    onChange();
    if (state.matches.length) onLocate(state.matches[state.cursor]);
  }
  input.addEventListener("compositionstart", () => { if (isCurrent()) composing = true; });
  input.addEventListener("compositionend", () => { composing = false; acceptInput(); });
  input.addEventListener("input", event => { if (!event.isComposing) acceptInput(); });
  input.addEventListener("search", acceptInput);
  input.addEventListener("keydown", event => {
    if (!isCurrent() || event.defaultPrevented) return;
    if (composing || event.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Enter") {
      event.preventDefault(); event.stopPropagation(); locate(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && input.value) {
      event.preventDefault(); event.stopPropagation(); input.value = ""; acceptInput();
    }
  });
  previous.addEventListener("click", () => locate(-1));
  next.addEventListener("click", () => locate(1));
  updateControls();
  element.append(input, previous, next, count);
  return {
    element,
    selectedIndex: () => state.matches[state.cursor] ?? -1,
    decorate(button, index) {
      button.classList.toggle("music-lyric-search-match", state.matchSet.has(index));
      button.classList.toggle("music-lyric-search-current", state.matches[state.cursor] === index);
    }
  };
}
