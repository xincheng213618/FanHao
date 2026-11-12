const normalize = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase();

export function createLibraryPeopleFilter({ input, status, list, retry, readCatalog, select }) {
  let rows = [], current = "", all, allCount = 0, counts = null, total = 0, counting = false;
  const number = new Intl.NumberFormat("zh-CN");

  function personButton(id, name, count, avatarUrl) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "library-person";
    button.setAttribute("aria-pressed", String(id === current));
    const avatar = document.createElement("span");
    avatar.className = "library-person-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = Array.from(name)[0] || "";
    if (avatarUrl) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = avatarUrl;
      avatar.append(image);
    }
    const label = document.createElement("span");
    label.className = "library-person-name";
    label.textContent = name;
    label.title = name;
    const countLabel = document.createElement("span");
    countLabel.className = "library-person-count";
    countLabel.title = "本地作品数";
    countLabel.textContent = number.format(count);
    button.append(avatar, label, countLabel);
    button.addEventListener("click", () => {
      if (current === id) return;
      current = id;
      all.setAttribute("aria-pressed", String(!id));
      for (const row of rows) row.button.setAttribute("aria-pressed", String(row.id === id));
      select(id);
    });
    return button;
  }

  function filter() {
    const query = normalize(input.value);
    let count = 0;
    for (const row of rows) {
      const matched = (!counts || counts.has(row.id)) && row.names.some((name) => name.includes(query));
      if (row.button.hidden === matched) row.button.hidden = !matched;
      if (matched) count++;
    }
    status.textContent = counting || `${number.format(count)} 人`;
  }

  function updateCounts() {
    if (!all) return;
    all.querySelector(".library-person-count").textContent = counting ? "" : number.format(counts ? total : allCount);
    for (const row of rows) {
      const label = row.button.querySelector(".library-person-count");
      const value = number.format(counts ? counts.get(row.id) || 0 : row.count);
      if (label.textContent !== value) label.textContent = value;
    }
    filter();
  }

  async function load() {
    retry.hidden = true;
    input.disabled = true;
    status.textContent = "正在读取人物…";
    try {
      const { people = [], totals } = await readCatalog("/api/library");
      rows = people.filter((person) => person.workCount > 0 && person.name?.trim())
        .sort((left, right) => right.workCount - left.workCount || left.name.localeCompare(right.name, "zh-CN"))
        .map((person) => {
          const id = String(person.id);
          const name = person.actorProfile?.displayName?.trim() || person.name.trim();
          const aliases = person.actorProfile?.aliases || [];
          const avatar = person.avatarUrl || (person.coverId ? `/media/image/${encodeURIComponent(person.coverId)}` : "");
          return { id, count: Number(person.workCount), names: [name, person.name, ...aliases].map(normalize), button: personButton(id, name, person.workCount, avatar) };
        });
      allCount = totals?.works ?? rows.reduce((count, row) => count + row.count, 0);
      all = personButton("", "全部人物", allCount);
      list.replaceChildren(all, ...rows.map((row) => row.button));
      input.disabled = false;
      updateCounts();
    } catch {
      status.textContent = "人物读取失败。";
      retry.hidden = false;
    }
  }

  retry.addEventListener("click", () => void load());
  input.addEventListener("input", filter);
  return {
    load,
    setCounts(next, nextTotal, pending = false) {
      counts = next;
      total = nextTotal;
      counting = pending;
      updateCounts();
    },
    setSelection(id) {
      current = id;
      all?.setAttribute("aria-pressed", String(!id));
      for (const row of rows) row.button.setAttribute("aria-pressed", String(row.id === id));
    }
  };
}
