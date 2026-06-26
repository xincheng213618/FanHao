const DEFAULT_TERMS = ["[A]"];
const MAX_HISTORY = 8;

function cleanTerm(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function uniqueTerms(terms) {
  const seen = new Set();
  const list = [];
  for (const value of terms) {
    const term = cleanTerm(value);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    list.push(term);
  }
  return list;
}

function readHistory(storageKey) {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return Array.isArray(raw) ? uniqueTerms(raw).slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

export function createSearchHistory({ container, input, storageKey, defaults = DEFAULT_TERMS, onSearch }) {
  let history = readHistory(storageKey);
  const defaultTerms = uniqueTerms(defaults);

  function items() {
    const defaultKeys = new Set(defaultTerms.map((term) => term.toLowerCase()));
    return [...defaultTerms, ...history.filter((term) => !defaultKeys.has(term.toLowerCase()))].slice(0, MAX_HISTORY + defaultTerms.length);
  }

  function persist() {
    localStorage.setItem(storageKey, JSON.stringify(history.slice(0, MAX_HISTORY)));
  }

  function save(value) {
    const term = cleanTerm(value);
    if (!term) return;
    history = [term, ...history.filter((item) => item.toLowerCase() !== term.toLowerCase())].slice(0, MAX_HISTORY);
    persist();
    render();
  }

  function run(value) {
    const term = cleanTerm(value) || defaultTerms[0] || "";
    if (!term) return;
    input.value = term;
    save(term);
    onSearch(term);
  }

  function render() {
    if (!container) return;
    container.innerHTML = "";
    for (const term of items()) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = term;
      if (defaultTerms.some((item) => item.toLowerCase() === term.toLowerCase())) {
        button.className = "default";
      }
      button.addEventListener("click", () => run(term));
      container.append(button);
    }
  }

  render();
  return { run, save, render };
}
