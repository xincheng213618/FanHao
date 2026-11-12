const STATUS_LABELS = {
  local: "已入库",
  known: "索引有资料，未入库",
  unknown: "索引无匹配",
  invalid: "无法识别"
};

export function createCodeBatchLookup(api) {
  const dialog = document.createElement("dialog");
  dialog.className = "code-batch-dialog";
  dialog.setAttribute("aria-labelledby", "codeBatchTitle");
  dialog.innerHTML = `
    <header class="code-batch-header">
      <h2 id="codeBatchTitle">批量核对番号</h2>
      <form method="dialog"><button type="submit">关闭</button></form>
    </header>
    <form class="code-batch-form">
      <label for="codeBatchInput">番号或文件名，每行一项，最多 100 行</label>
      <textarea id="codeBatchInput" rows="5" required autofocus spellcheck="false"></textarea>
      <button type="submit" class="code-batch-primary">核对清单</button>
    </form>
    <p class="code-batch-status" role="status"></p>
    <div class="code-batch-results" hidden>
      <label>结果筛选
        <select aria-label="结果筛选">
          <option value="all">全部</option>
          <option value="local">已入库</option>
          <option value="known">索引有资料，未入库</option>
          <option value="unknown">索引无匹配</option>
          <option value="invalid">无法识别</option>
        </select>
      </label>
      <button class="code-batch-copy" type="button">复制待核对番号</button>
    </div>
    <textarea class="code-batch-copy-text" aria-label="待核对番号" rows="4" readonly hidden></textarea>
    <p class="code-batch-copy-status" role="status"></p>
    <ul class="code-batch-list" aria-label="番号核对结果"></ul>`;
  const form = dialog.querySelector(".code-batch-form");
  const input = form.querySelector("textarea");
  const submit = form.querySelector("button");
  const status = dialog.querySelector(".code-batch-status");
  const filter = dialog.querySelector("select");
  const copy = dialog.querySelector(".code-batch-copy");
  const copyText = dialog.querySelector(".code-batch-copy-text");
  const copyStatus = dialog.querySelector(".code-batch-copy-status");
  const resultTools = dialog.querySelector(".code-batch-results");
  const list = dialog.querySelector(".code-batch-list");
  let result, request;
  let generation = 0;

  function cancel() {
    generation++;
    request?.abort();
    request = null;
    submit.disabled = false;
  }

  function render() {
    const items = result?.items.filter(({ status }) => filter.value === "all" || filter.value === status) || [];
    list.replaceChildren(...items.map((item) => {
      const row = document.createElement("li");
      const name = document.createElement(item.searchCode ? "a" : "strong");
      name.textContent = item.code || `第 ${item.line} 行`;
      if (item.searchCode) {
        name.href = `/fanhao?${new URLSearchParams({ q: item.searchCode })}`;
        name.target = "_blank";
        name.rel = "noopener";
      }
      const badge = document.createElement("span");
      badge.className = "code-batch-badge";
      badge.dataset.status = item.status;
      badge.textContent = STATUS_LABELS[item.status];
      row.append(name, badge);
      if (item.title) {
        const title = document.createElement("span");
        title.className = "code-batch-work-title";
        title.textContent = item.title;
        row.append(title);
      }
      return row;
    }));
    if (result && !items.length) {
      const empty = document.createElement("li");
      empty.textContent = "这个分类没有结果。";
      list.append(empty);
    }
    resultTools.hidden = !result;
    copy.disabled = !result?.items.some(({ status }) => status === "known" || status === "unknown");
    list.scrollTop = 0;
  }

  function reset() {
    result = null;
    filter.value = "all";
    status.textContent = "";
    status.classList.remove("is-error");
    copyStatus.textContent = "";
    copyText.hidden = true;
    render();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    cancel();
    reset();
    if (!input.value.trim()) {
      status.textContent = "请粘贴要核对的番号或文件名。";
      input.focus();
      return;
    }
    const owner = new AbortController();
    request = owner;
    submit.disabled = true;
    status.textContent = "正在核对馆藏索引…";
    try {
      const payload = await api("/api/code-prefixes/lookup", {
        method: "POST", body: { input: input.value }, signal: owner.signal
      });
      if (request !== owner || !dialog.open) return;
      result = payload;
      const counts = { local: 0, known: 0, unknown: 0, invalid: 0 };
      for (const item of result.items) counts[item.status]++;
      const labels = Object.entries(counts).map(([key, count]) => `${STATUS_LABELS[key]} ${count}`);
      if (result.duplicateCount) labels.push(`合并重复 ${result.duplicateCount}`);
      status.textContent = labels.join(" · ");
      render();
    } catch (error) {
      if (request !== owner || !dialog.open) return;
      status.textContent = error.message;
      status.classList.add("is-error");
    } finally {
      if (request === owner) {
        request = null;
        submit.disabled = false;
      }
    }
  });
  input.addEventListener("input", () => { cancel(); reset(); });
  filter.addEventListener("change", render);
  copy.addEventListener("click", async () => {
    const owner = generation;
    const text = result.items.filter(({ status }) => status === "known" || status === "unknown").map(({ code }) => code).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      if (owner === generation && dialog.open) copyStatus.textContent = "已复制待核对番号。";
    } catch {
      if (owner !== generation || !dialog.open) return;
      copyText.value = text;
      copyText.hidden = false;
      copyText.focus();
      copyText.select();
      copyStatus.textContent = "清单已选中，可直接复制。";
    }
  });
  dialog.addEventListener("close", () => {
    if (request) status.textContent = "";
    cancel();
  });
  document.body.append(dialog);
  return {
    open() { if (!dialog.open) dialog.showModal(); },
    close() { if (dialog.open) dialog.close(); }
  };
}
