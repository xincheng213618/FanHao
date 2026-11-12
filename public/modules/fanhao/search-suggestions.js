const PERSON_LIMIT = 2;
const WORK_LIMIT = 5;

function suggestionsFrom(data, visibleWorks) {
  const candidates = [];
  const people = new Set();
  const works = new Set();

  for (const person of Array.isArray(data?.people) ? data.people : []) {
    const label = person?.actorProfile?.displayName || person?.name;
    if (!person?.id || !label || people.has(person.id) || person.searchScopes?.length === 0) continue;
    people.add(person.id);
    candidates.push({ kind: "人物", label, person });
    if (people.size === PERSON_LIMIT) break;
  }

  for (const work of visibleWorks(Array.isArray(data?.works) ? data.works : [])) {
    const label = String(work?.title || work?.infoSummary?.title || work?.infoSummary?.code || "").trim();
    if (!work?.id || !label || works.has(work.id) || (work.missingLocal && !work.javdbUrl)) continue;
    works.add(work.id);
    const code = String(work.infoSummary?.code || "").trim();
    const title = code && !label.toUpperCase().includes(code.toUpperCase()) ? `${code} · ${label}` : label;
    candidates.push({ kind: work.missingLocal ? "未下载" : "作品", label: title, work });
    if (works.size === WORK_LIMIT) break;
  }
  return candidates;
}

export function createWorkSearchSuggestions({ input, list, visibleWorks, onPerson, onWork, onSearch }) {
  if (!input || !list) return { close() {}, show() {}, handleKey: () => false };
  const document = input.ownerDocument;
  let generation = 0;
  let visibleQuery = "";
  let options = [];
  let selected = -1;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");

  function close() {
    generation++;
    visibleQuery = "";
    options = [];
    selected = -1;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function ownsInput(query) {
    return document.activeElement === input && document.hasFocus() && input.value.trim() === query;
  }

  async function show(query, result) {
    const current = generation;
    const data = await result;
    if (current !== generation || !ownsInput(query)) return;
    const candidates = suggestionsFrom(data, visibleWorks);
    if (!candidates.length) return;
    candidates.push({ kind: "", label: "查看全部搜索结果" });
    visibleQuery = query;
    options = candidates.map((candidate, index) => {
      const row = document.createElement("div");
      row.className = "work-search-option";
      row.id = `${list.id}-${index}`;
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      const label = document.createElement("span");
      label.className = "work-search-option-label";
      label.textContent = candidate.label;
      label.title = candidate.label;
      row.append(label);
      if (candidate.kind) {
        const kind = document.createElement("span");
        kind.className = "work-search-option-kind";
        kind.textContent = candidate.kind;
        row.append(kind);
      }
      return { candidate, row };
    });
    list.replaceChildren(...options.map(({ row }) => row));
    list.scrollTop = 0;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function choose(index) {
    const option = options[index];
    if (!option || !ownsInput(visibleQuery)) return;
    const { candidate } = option;
    const query = visibleQuery;
    close();
    if (candidate.person) onPerson(candidate.person);
    else if (candidate.work) onWork(candidate.work);
    else onSearch(query);
  }

  function select(index) {
    options[selected]?.row.setAttribute("aria-selected", "false");
    selected = index;
    const { row } = options[index];
    row.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", row.id);
    const { top, bottom } = row.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();
    if (top < bounds.top) list.scrollTop += top - bounds.top;
    else if (bottom > bounds.bottom) list.scrollTop += bottom - bounds.bottom;
  }

  function handleKey(event) {
    if (list.hidden || !ownsInput(visibleQuery)) return false;
    const { key } = event;
    if (key === "ArrowDown" || key === "ArrowUp") {
      const direction = key === "ArrowDown" ? 1 : -1;
      select(selected < 0 && direction < 0 ? options.length - 1 : (selected + direction + options.length) % options.length);
    } else if (key === "Escape") close();
    else if (key === "Enter" && selected >= 0) choose(selected);
    else return false;
    event.preventDefault();
    return true;
  }

  input.addEventListener("blur", close);
  document.defaultView.addEventListener("blur", close);
  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const row = event.target.closest(".work-search-option");
    choose(options.findIndex((option) => option.row === row));
  });
  return { close, show, handleKey };
}
