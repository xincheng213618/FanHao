const SEARCH_HISTORY_KEY = "fanhao.shortVideo.searchHistory";
const SEARCH_HISTORY_LIMIT = 6;
const SEARCH_SUGGESTION_LIMIT = 8;

export function createShortVideoSearchModule({ api, createIcon, getState, onSearch }) {
  let suggestionTimer = 0;
  let suggestionRequestId = 0;
  let formSequence = 0;

  function renderForm(options = {}) {
    const state = getState() || {};
    const form = document.createElement("form");
    form.className = `short-video-search${options.compact ? " is-compact" : ""}`;
    form.dataset.shortVideoSearchForm = "1";
    form.setAttribute("role", "search");

    const field = document.createElement("div");
    field.className = "short-video-search-field";
    field.append(createIcon("search"));

    const input = document.createElement("input");
    input.type = "search";
    input.value = String(options.value ?? state.query ?? "");
    input.placeholder = options.placeholder || "搜作品、作者、话题";
    input.autocomplete = "off";
    input.dataset.shortVideoSearchInput = "1";
    input.setAttribute("aria-label", options.ariaLabel || "搜索短视频、图文、作者或话题");

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "short-video-search-clear";
    clear.setAttribute("aria-label", options.clearLabel || "清除短视频搜索");
    clear.append(createIcon("close"));
    clear.hidden = !input.value;

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "short-video-search-submit";
    submit.textContent = options.submitLabel || "搜索";

    const suggestionsEnabled = options.suggestions !== false;
    const panel = suggestionsEnabled ? createSuggestionPanel(++formSequence) : null;
    let suggestionItems = [];
    let activeIndex = -1;

    if (panel) {
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-controls", panel.id);
      input.setAttribute("aria-expanded", "false");
    }

    const submitSearch = (value) => {
      const callback = options.onSubmit || onSearch;
      callback?.(normalizeQuery(value));
    };
    const closePanel = () => {
      if (!panel) return;
      panel.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      activeIndex = -1;
    };
    const choose = (item) => {
      const query = normalizeQuery(String(item?.query || item?.label || "").replace(/^#/, ""));
      input.value = query;
      clear.hidden = !query;
      closePanel();
      submitSearch(query);
    };
    const renderSuggestions = (items, label = "搜索建议") => {
      if (!panel) return;
      suggestionItems = Array.isArray(items) ? items.filter((item) => item?.label || item?.query) : [];
      panel.innerHTML = "";
      activeIndex = -1;
      if (!suggestionItems.length) {
        closePanel();
        return;
      }
      panel.append(createSuggestionHeading(label, closePanel));
      suggestionItems.forEach((item, index) => {
        panel.append(createSuggestionButton(item, index, panel.id, choose));
      });
      panel.hidden = false;
      input.setAttribute("aria-expanded", "true");
    };
    const showRecent = () => {
      renderSuggestions(
        readHistory().map((query) => ({ kind: "recent", label: query, query, detail: "最近搜索" })),
        "最近搜索"
      );
    };
    const requestSuggestions = (value) => {
      if (!panel) return;
      window.clearTimeout(suggestionTimer);
      const query = normalizeQuery(value);
      if (!query) {
        showRecent();
        return;
      }
      suggestionTimer = window.setTimeout(async () => {
        const requestId = ++suggestionRequestId;
        try {
          const params = new URLSearchParams({ q: query, limit: String(SEARCH_SUGGESTION_LIMIT) });
          const media = getState()?.media;
          if (media && media !== "all") params.set("media", media);
          const extraParams = typeof options.params === "function" ? options.params() : options.params;
          for (const [key, value] of Object.entries(extraParams || {})) {
            if (value !== undefined && value !== null && String(value).trim()) params.set(key, String(value));
          }
          const result = await api(`/api/short-videos/suggestions?${params}`);
          if (requestId !== suggestionRequestId || !panel.isConnected || input.value.trim() !== query) return;
          renderSuggestions(result.suggestions || []);
        } catch {
          if (requestId === suggestionRequestId) closePanel();
        }
      }, 220);
    };
    const moveActive = (direction) => {
      if (!panel || panel.hidden || !suggestionItems.length) return false;
      activeIndex = (activeIndex + direction + suggestionItems.length) % suggestionItems.length;
      const buttons = [...panel.querySelectorAll(".short-video-search-suggestion")];
      buttons.forEach((button, index) => {
        const active = index === activeIndex;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
      const active = buttons[activeIndex];
      if (active) {
        input.setAttribute("aria-activedescendant", active.id);
        active.scrollIntoView({ block: "nearest" });
      }
      return true;
    };

    input.addEventListener("focus", () => requestSuggestions(input.value));
    input.addEventListener("input", () => {
      clear.hidden = !input.value;
      requestSuggestions(input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && moveActive(1)) event.preventDefault();
      else if (event.key === "ArrowUp" && moveActive(-1)) event.preventDefault();
      else if (event.key === "Enter" && activeIndex >= 0 && suggestionItems[activeIndex]) {
        event.preventDefault();
        choose(suggestionItems[activeIndex]);
      } else if (event.key === "Escape" && panel && !panel.hidden) {
        event.preventDefault();
        closePanel();
      }
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      closePanel();
      submitSearch(input.value);
    });
    form.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!form.contains(document.activeElement)) closePanel();
      }, 0);
    });
    clear.addEventListener("click", () => {
      input.value = "";
      clear.hidden = true;
      if (getState()?.query) submitSearch("");
      else {
        input.focus();
        showRecent();
      }
    });

    field.append(input, clear);
    form.append(field, submit);
    if (panel) form.append(panel);
    return form;
  }

  function createSuggestionHeading(label, closePanel) {
    const heading = document.createElement("div");
    heading.className = "short-video-search-suggestion-heading";
    const text = document.createElement("span");
    text.textContent = label;
    heading.append(text);
    if (label === "最近搜索") {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "清空";
      clear.setAttribute("aria-label", "清空短视频搜索历史");
      clear.addEventListener("pointerdown", (event) => event.preventDefault());
      clear.addEventListener("click", () => {
        clearHistory();
        closePanel();
      });
      heading.append(clear);
    }
    return heading;
  }

  function createSuggestionButton(item, index, panelId, choose) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `${panelId}-option-${index}`;
    button.className = "short-video-search-suggestion";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", "false");
    const icon = createIcon(item.kind === "tag" ? "link" : item.kind === "title" ? "play" : "search");
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = item.label || item.query;
    const detail = document.createElement("small");
    detail.textContent = item.detail || (item.kind === "recent" ? "最近搜索" : "搜索建议");
    copy.append(name, detail);
    button.append(icon, copy);
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => choose(item));
    return button;
  }

  function remember(value) {
    const query = normalizeQuery(value);
    if (!query) return;
    try {
      const next = [query, ...readHistory().filter((item) => item !== query)].slice(0, SEARCH_HISTORY_LIMIT);
      window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
    } catch {}
  }

  function readHistory() {
    try {
      const values = JSON.parse(window.localStorage.getItem(SEARCH_HISTORY_KEY) || "[]");
      return Array.isArray(values)
        ? values.map(normalizeQuery).filter(Boolean).slice(0, SEARCH_HISTORY_LIMIT)
        : [];
    } catch {
      return [];
    }
  }

  function clearHistory() {
    try {
      window.localStorage.removeItem(SEARCH_HISTORY_KEY);
    } catch {}
  }

  function focus(root) {
    const input = root?.querySelector?.("[data-short-video-search-input]");
    input?.focus?.({ preventScroll: true });
    input?.select?.();
  }

  function syncTrigger(root) {
    const searchText = root?.querySelector?.(".short-video-browser-search-text");
    if (searchText) searchText.textContent = shortVideoSearchLabel(getState());
  }

  return {
    focus,
    label: () => shortVideoSearchLabel(getState()),
    remember,
    renderForm,
    syncTrigger
  };
}

export function shortVideoSearchLabel(state = {}) {
  return String(state.query || "").trim()
    || (state.topic ? `#${state.topic}` : "")
    || (state.sound ? `♫ ${state.soundInfo?.title || "原声流"}` : "")
    || "搜索你感兴趣的内容";
}

function createSuggestionPanel(sequence) {
  const panel = document.createElement("div");
  panel.id = `short-video-search-suggestions-${sequence}`;
  panel.className = "short-video-search-suggestions";
  panel.setAttribute("role", "listbox");
  panel.hidden = true;
  return panel;
}

function normalizeQuery(value) {
  return String(value || "").trim().slice(0, 120);
}
