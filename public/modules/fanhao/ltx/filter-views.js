const STORAGE_KEY = "fanhao.ltx.filterViews";
const FILTER_KEYS = ["q", "actor", "status", "local", "subtitle", "sort", "order"];

export function writeFilterViewUrl(params, mode = "push") {
  const url = new URL(location.href);
  for (const key of FILTER_KEYS) {
    if (params.has(key)) url.searchParams.set(key, params.get(key));
    else url.searchParams.delete(key);
  }
  if (url.href === location.href) return;
  if (mode === "replace") history.replaceState(history.state, "", url);
  else history.pushState(history.state, "", url);
}

function readSavedViews() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => typeof item?.name === "string" && typeof item.params === "string") : [];
  } catch {
    return [];
  }
}

export function installFilterViews({ getParams, applyParams }) {
  const dialog = document.getElementById("filterViews");
  const form = document.getElementById("saveFilterView");
  const nameInput = document.getElementById("filterViewName");
  const list = document.getElementById("savedFilterViews");
  const empty = document.getElementById("filterViewsEmpty");
  const linkInput = document.getElementById("filterViewLink");
  const status = document.getElementById("filterViewsStatus");
  let views = readSavedViews();
  let dialogVersion = 0;

  function activate(params) {
    applyParams(new URLSearchParams(params));
    dialog.close();
  }

  function persist(message) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
      status.textContent = message;
    } catch {
      status.textContent = "浏览器存储不可用，这次更改仅在当前页面生效。";
    }
  }

  function render() {
    const selected = getParams().toString();
    list.replaceChildren(...views.map(({ name, params }, index) => {
      const row = document.createElement("li");
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "fanhao-pill";
      apply.textContent = name;
      if (params === selected) apply.setAttribute("aria-current", "true");
      apply.addEventListener("click", () => activate(params));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "fanhao-pill";
      remove.textContent = "删除";
      remove.setAttribute("aria-label", `删除 ${name}`);
      remove.addEventListener("click", () => {
        views.splice(index, 1);
        persist(`已删除「${name}」。`);
        render();
        (list.children[Math.min(index, list.children.length - 1)]?.firstElementChild || nameInput).focus();
      });
      row.append(apply, remove);
      return row;
    }));
    empty.hidden = views.length > 0;
  }

  document.getElementById("openFilterViews").addEventListener("click", () => {
    dialogVersion++;
    nameInput.value = "";
    status.textContent = "";
    linkInput.hidden = true;
    render();
    dialog.showModal();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    views = readSavedViews();
    if (dialog.open) render();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = "请填写视图名称。";
      nameInput.focus();
      return;
    }
    const existing = views.some((item) => item.name === name);
    views = [{ name, params: getParams().toString() }, ...views.filter((item) => item.name !== name)];
    persist(existing ? `已更新「${name}」。` : `已保存「${name}」。`);
    nameInput.value = "";
    render();
  });
  document.getElementById("resetFilterView").addEventListener("click", () => activate(""));
  document.getElementById("copyFilterView").addEventListener("click", async () => {
    const version = dialogVersion;
    const url = new URL(location.pathname, location.origin);
    url.search = getParams().toString();
    try {
      await navigator.clipboard.writeText(url.href);
      if (dialog.open && version === dialogVersion) {
        linkInput.hidden = true;
        status.textContent = "已复制当前筛选链接。";
      }
    } catch {
      if (!dialog.open || version !== dialogVersion) return;
      linkInput.value = url.href;
      linkInput.hidden = false;
      linkInput.focus();
      linkInput.select();
      status.textContent = "链接已选中，可直接复制。";
    }
  });
}
