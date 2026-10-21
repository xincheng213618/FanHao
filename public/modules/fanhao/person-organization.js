export async function openPersonOrganizationDialog({ person, button, api, isCurrent, refreshPerson }) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "检查目录中";
  let overlay;
  try {
    const response = await api("/api/admin/organize-person", { method: "POST", body: { personId: person.id, preview: true } });
    if (!isCurrent()) return;
    overlay = document.createElement("div");
    overlay.className = "mapping-modal-backdrop";
    const dialog = document.createElement("section");
    dialog.className = "mapping-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "重新整理人物目录");
    const make = (tag, text, className = "") => {
      const node = document.createElement(tag);
      node.textContent = text;
      if (className) node.className = className;
      return node;
    };
    const header = make("header", "", "mapping-modal-header");
    const title = make("h3", `重新整理 · ${person.name}`);
    const close = make("button", "关闭", "folder-button compact");
    close.type = "button";
    header.append(title, close);
    const content = make("div", "", "mapping-modal-content person-organization-content");
    const plan = response.plan;
    content.append(make("p", "按“人物目录 / 番号＋标题 / 视频、封面和 info”整理，保留视频原名和分段标记。文件夹修改日期设为发布日期；缺失时保持原样。已有目标目录或番号不明确时保留原位。"));
    if (plan) {
      content.append(make("p", `${plan.workCount} 部作品，${plan.moveCount} 个目录需要整理，${plan.skipped.length} 部跳过。`));
      if (plan.obsoleteCoverCount) content.append(make("p", `新封面写入成功后，清理 ${plan.obsoleteCoverCount} 个已识别的旧封面文件。`));
      if (["running", "error"].includes(plan.status)) content.append(make("p", "发现上次未完成的整理，本次会继续该计划。"));
    }
    const label = make("label", "");
    const metadata = document.createElement("input");
    metadata.type = "checkbox";
    metadata.checked = true;
    label.append(metadata, document.createTextNode(" 从 JavDB 更新全部作品列表、本地作品资料与封面，重写 info（失败保留原资料与封面，不备份）"));
    content.append(label);
    const details = document.createElement("details");
    details.append(make("summary", "查看本次目录与跳过原因"));
    const list = make("ul", "", "person-organization-list");
    for (const group of plan?.groups || []) list.append(make("li", `${group.code} → ${group.target}`));
    for (const item of plan?.skipped || []) list.append(make("li", `跳过 ${item.code || "未知番号"}：${item.reason}`));
    for (const file of plan?.obsolete || []) list.append(make("li", `整理成功后清理根目录遗留资料：${file}`));
    details.append(list);
    content.append(details);
    const status = make("p", "", "person-organization-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const start = make("button", response.task ? "查看运行进度" : "开始整理", "folder-button");
    start.type = "button";
    start.disabled = !response.task && !plan?.workCount;
    const footer = make("div", "", "mapping-modal-footer");
    footer.append(start);
    content.append(status, footer);
    dialog.append(header, content);
    overlay.append(dialog);
    document.body.append(overlay);
    let closed = false;
    const dismiss = () => {
      closed = true;
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      if (button.isConnected) button.focus();
    };
    const onKey = (event) => {
      if (event.key === "Escape") { dismiss(); return; }
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll("button:not(:disabled), input:not(:disabled), summary")];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    close.addEventListener("click", dismiss);
    document.addEventListener("keydown", onKey);
    close.focus();
    const monitor = async (task) => {
      while (!closed && ["running", "stopping"].includes(task.status)) {
        status.textContent = task.logs?.at(-1) || "整理任务正在后台运行，关闭窗口后仍会继续";
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        if (closed) return;
        const data = await api("/api/admin/tasks");
        task = (data.tasks || []).find((item) => item.id === task.id) || task;
      }
      if (closed) return;
      if (isCurrent()) await refreshPerson();
      status.textContent = task.status === "done" ? (metadata.checked ? "整理完成，封面、info 和本地索引已同步。" : "整理完成，目录和本地索引已同步。")
        : task.logs?.findLast((line) => /^ERROR\s/.test(line)) || "任务已中断，可再次点击重新整理继续。";
      const logs = make("pre", (task.logs || []).filter((line) => /WARN|ERROR|整理结果|清理/.test(line)).join("\n"));
      logs.style.whiteSpace = "pre-wrap";
      logs.style.overflowWrap = "anywhere";
      content.append(logs);
      start.textContent = "已结束";
    };
    start.addEventListener("click", async () => {
      start.disabled = true;
      metadata.disabled = true;
      try {
        const data = response.task ? response : await api("/api/admin/organize-person", { method: "POST",
          body: { personId: person.id, planId: plan.id, refreshMetadata: metadata.checked } });
        status.textContent = `任务 ${data.task.id} 已启动；关闭窗口后会继续，可在设置与运维查看进度。`;
        await monitor(data.task);
      } catch (error) {
        status.textContent = error.message || "读取整理进度失败，可重新打开查看";
        start.disabled = false;
        metadata.disabled = false;
      }
    });
  } catch (error) {
    button.title = error.message || "目录检查失败";
    button.textContent = "整理检查失败";
    window.alert(error.message || "目录检查失败");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}
