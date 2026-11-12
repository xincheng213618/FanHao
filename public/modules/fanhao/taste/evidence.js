export function createTasteEvidenceDialog({ api, byId, makeNode, workLink, refresh }) {
  const dialog = byId("tasteEvidence");
  const status = byId("evidenceStatus");
  const works = byId("evidenceWorks");
  const marked = byId("evidenceMarked");
  const unmarked = byId("evidenceUnmarked");
  const previous = byId("evidencePrevious");
  const next = byId("evidenceNext");
  const retry = byId("evidenceRetry");
  const reread = byId("evidenceRefresh");
  let selection, controller, page;
  let scope = "marked", requestedOffset = 0;

  function cancel() {
    controller?.abort();
    controller = null;
  }

  async function load(offset) {
    cancel();
    const request = new AbortController();
    controller = request;
    requestedOffset = offset;
    const { snapshot, dimension, id } = selection;
    const params = new URLSearchParams({ snapshot, dimension, feature: id, scope, offset: String(offset) });
    previous.disabled = next.disabled = retry.hidden = reread.hidden = true;
    marked.setAttribute("aria-pressed", String(scope === "marked"));
    unmarked.setAttribute("aria-pressed", String(scope === "unmarked"));
    status.classList.remove("error");
    status.textContent = "正在读取匹配作品…";
    works.replaceChildren();
    try {
      const result = await api(`/api/fanhao/taste/evidence?${params}`, { signal: request.signal, cache: "no-store" });
      if (controller !== request || !dialog.open) return;
      page = result;
      works.replaceChildren(...page.items.map((work) => {
        const row = document.createElement("li");
        const link = workLink(work);
        if (link.tagName === "A") {
          link.target = "_blank";
          link.rel = "noopener";
        }
        row.append(link);
        if (work.title && work.title !== work.code) row.append(makeNode("span", work.title));
        return row;
      }));
      works.scrollTop = 0;
      previous.disabled = page.offset === 0;
      next.disabled = !page.hasMore;
      status.textContent = page.items.length
        ? `第 ${page.offset + 1}–${page.offset + page.items.length} 部，共 ${page.total} 部`
        : "这个标记状态下没有匹配的作品。";
    } catch (error) {
      if (controller !== request || !dialog.open) return;
      status.textContent = error.message;
      status.classList.add("error");
      const expired = error.code === "TASTE_SNAPSHOT_EXPIRED";
      retry.hidden = expired;
      reread.hidden = !expired;
    } finally {
      if (controller === request) controller = null;
    }
  }

  function selectScope(value) {
    if (value === scope) return;
    scope = value;
    void load(0);
  }

  marked.addEventListener("click", () => selectScope("marked"));
  unmarked.addEventListener("click", () => selectScope("unmarked"));
  previous.addEventListener("click", () => load(Math.max(0, page.offset - page.limit)));
  next.addEventListener("click", () => load(page.offset + page.limit));
  retry.addEventListener("click", () => load(requestedOffset));
  reread.addEventListener("click", () => { dialog.close(); void refresh(); });
  dialog.addEventListener("close", cancel);
  return {
    open(value) {
      selection = value;
      scope = "marked";
      marked.textContent = `特别喜欢 [A] · ${value.marked}`;
      unmarked.textContent = `未标记 · ${value.total - value.marked}`;
      byId("evidenceTitle").textContent = `${value.label} · ${value.name}`;
      dialog.showModal();
      void load(0);
    },
    close() {
      cancel();
      if (dialog.open) dialog.close();
    }
  };
}
