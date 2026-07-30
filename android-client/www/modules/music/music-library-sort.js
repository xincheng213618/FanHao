export function createMusicLibrarySort(deps) {
  const {
    isFocusedLibraryView,
    renderShell,
    setMusicSymbol,
    state,
    symbolButton,
    updateListParams
  } = deps;

  function renderMusicSort() {
    const sortOptions = musicSortOptions();
    const selectedValue = activeMusicSortValue();
    if (isFocusedLibraryView()) {
      const selectedLabel = sortOptions.find(([value]) => value === selectedValue)?.[1] || "排序";
      const trigger = symbolButton(
        "sort",
        openLibrarySort,
        false,
        "music-mobile-sort music-mobile-focused-library-sort",
        `排序方式：${selectedLabel}`
      );
      trigger.setAttribute("aria-expanded", state.sortSheetOpen ? "true" : "false");
      return trigger;
    }
    const sort = document.createElement("select");
    sort.className = "music-mobile-sort";
    sort.setAttribute("aria-label", state.mode === "artists" ? "歌手排序" : state.mode === "albums" ? "专辑排序" : "音乐排序");
    sort.disabled = !["library", "artists", "albums"].includes(state.mode);
    for (const [value, label] of sortOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = selectedValue === value;
      sort.append(option);
    }
    sort.addEventListener("change", () => updateListParams(
      state.mode === "artists"
        ? { artistSort: sort.value }
        : state.mode === "albums"
          ? { albumSort: sort.value }
          : { sort: sort.value }
    ));
    return sort;
  }

  function musicSortOptions() {
    return state.mode === "artists" ? [
      ["count", "歌曲最多"],
      ["name", "按名称"]
    ] : state.mode === "albums" ? [
      ["updated", "最近入库"],
      ["title", "按名称"],
      ["year", "按年份"],
      ["tracks", "歌曲最多"]
    ] : [
      ["album", state.query ? "匹配度" : "专辑"],
      ["artist", "歌手"],
      ["title", "歌名"],
      ["duration", "时长"],
      ["played", "最近"],
      ["favorite", "收藏"],
      ["rating", "评分"]
    ];
  }

  function activeMusicSortValue() {
    if (state.mode === "artists") return state.artistSort;
    if (state.mode === "albums") return state.albumSort;
    return state.sort;
  }

  function openLibrarySort() {
    state.sortSheetOpen = true;
    state.libraryFiltersOpen = false;
    renderShell();
  }

  function closeLibrarySort() {
    if (!state.sortSheetOpen) return;
    state.sortSheetOpen = false;
    renderShell();
  }

  function renderLibrarySortBackdrop() {
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "music-mobile-settings-backdrop music-mobile-library-sort-backdrop";
    backdrop.setAttribute("aria-label", "关闭排序方式");
    backdrop.addEventListener("click", closeLibrarySort);
    return backdrop;
  }

  function renderLibrarySortSheet() {
    const sheet = document.createElement("section");
    sheet.className = "music-mobile-settings-sheet music-mobile-library-sort-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "选择排序方式");
    const head = document.createElement("header");
    head.className = "music-mobile-library-sort-head";
    const title = document.createElement("strong");
    title.textContent = "排序方式";
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "完成";
    done.addEventListener("click", closeLibrarySort);
    head.append(title, done);
    const list = document.createElement("div");
    list.className = "music-mobile-library-sort-list";
    const selectedValue = activeMusicSortValue();
    for (const [value, label] of musicSortOptions()) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.className = `music-mobile-library-sort-choice${value === selectedValue ? " active" : ""}`;
      const choiceLabel = document.createElement("strong");
      choiceLabel.textContent = label;
      const stateLabel = document.createElement("span");
      stateLabel.className = "music-mobile-library-sort-state";
      if (value === selectedValue) {
        setMusicSymbol(stateLabel, "check");
        stateLabel.setAttribute("aria-label", "当前排序");
      } else {
        stateLabel.setAttribute("aria-hidden", "true");
      }
      choice.append(choiceLabel, stateLabel);
      choice.addEventListener("click", () => {
        state.sortSheetOpen = false;
        if (value === selectedValue) {
          renderShell();
          return;
        }
        updateListParams({ sort: value });
      });
      list.append(choice);
    }
    sheet.append(head, list);
    window.requestAnimationFrame(() => sheet.querySelector(".music-mobile-library-sort-choice.active")?.focus());
    return sheet;
  }

  return {
    closeLibrarySort,
    renderLibrarySortBackdrop,
    renderLibrarySortSheet,
    renderMusicSort
  };
}
