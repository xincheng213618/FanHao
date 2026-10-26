import { createApiClient } from "../../../js/api.js";

const api = createApiClient();
const $ = (id) => document.getElementById(id);
const percent = (value) => `${(100 * value).toFixed(1)}%`;
const count = (value) => Number(value).toLocaleString("zh-CN");
let profile = null, selected = "people", controller = null;
function node(tag, text, className = "") { const element = document.createElement(tag); element.textContent = text; element.className = className; return element; }
function workLink(work) {
  if (!work.code) return node("span", "未识别番号");
  const link = node("a", work.code); link.href = `/fanhao?q=${encodeURIComponent(work.code)}`; return link;
}
function statistic(label, value, detail, highlighted = false) {
  const card = node("article", "", `stat${highlighted ? " highlight" : ""}`);
  card.append(node("span", label), node("strong", value), node("small", detail)); return card;
}
function shareBar(share, all = false) {
  const row = node("div", "", "bar-row"), track = node("span", "", "bar-track"), bar = node("span", "", `bar${all ? " all" : ""}`);
  bar.style.width = `${Math.min(100, Math.max(0, share * 100))}%`; track.append(bar);
  row.append(track, node("span", percent(share), "bar-value")); return row;
}
function renderDimension() {
  if (!profile) return;
  const dimension = profile.dimensions.find((item) => item.key === selected) || profile.dimensions[0];
  selected = dimension.key;
  for (const button of $("dimensions").children) button.setAttribute("aria-pressed", String(button.dataset.dimension === selected));
  $("coverage").textContent = `本维度有资料：馆藏 ${count(dimension.known)} / ${count(profile.summary.total)} 部（${percent(dimension.coverage)}），[A] ${count(dimension.markedKnown)} / ${count(profile.summary.marked)} 部（${percent(dimension.markedCoverage)}）。有资料作品的整体 [A] 标记率：${percent(dimension.baselineRate)}。${dimension.coverage < .5 ? "资料覆盖不足一半，这些结果先作为线索。" : ""}`;
  const rows = dimension[$("sort").value] || [];
  const fragment = document.createDocumentFragment();
  for (const item of rows) {
    const row = document.createElement("tr"), feature = document.createElement("td"), bars = node("div", "", "bars");
    bars.setAttribute("aria-label", `[A] 中占 ${percent(item.markedShare)}，有资料馆藏中占 ${percent(item.collectionShare)}`);
    bars.append(shareBar(item.markedShare), shareBar(item.collectionShare, true));
    feature.append(node("span", item.name, "feature-name"), bars);
    const samples = node("td", `${count(item.marked)} / ${count(item.total)}`, "numeric");
    const lift = node("td", `${item.adjustedLift.toFixed(2)}×`, "numeric");
    lift.append(node("small", item.support === "repeated" ? "多次标记" : "样本较少", "support"));
    const examples = document.createElement("td"), links = node("div", "", "examples");
    for (const example of item.examples) links.append(workLink(example));
    examples.append(links); row.append(feature, samples, lift, examples); fragment.append(row);
  }
  if (!rows.length) {
    const row = document.createElement("tr"), cell = node("td", "目前没有足够的重复样本支持这类偏好。可以切换维度，或查看 [A] 中出现最多的特征。", "empty");
    cell.colSpan = 4; row.append(cell); fragment.append(row);
  }
  $("features").replaceChildren(fragment);
}
function render(value) {
  profile = value;
  const summary = profile.summary;
  $("summary").replaceChildren(statistic("分析馆藏", count(summary.total), `合并 ${count(summary.duplicateRows)} 条重复版本记录`),
    statistic("特别喜欢 [A]", count(summary.marked), "只认作品目录标记", true),
    statistic("[A] 标记率", percent(summary.markedRate), "已标记 / 全部去重馆藏"));
  $("dimensions").replaceChildren(...profile.dimensions.map((dimension) => {
    const button = node("button", dimension.label); button.type = "button"; button.dataset.dimension = dimension.key;
    button.addEventListener("click", () => { selected = dimension.key; renderDimension(); }); return button;
  }));
  renderDimension();
  $("recommendations").replaceChildren(...profile.recommendations.map((work) => {
    const card = node("article", "", "recommendation"); card.append(workLink(work), node("p", work.title || work.code));
    card.append(node("small", work.reasons.map((reason) => `${reason.dimension}「${reason.name}」在 ${reason.marked} 部 [A] 中出现`).join("；")));
    return card;
  }));
  if (!profile.recommendations.length) $("recommendations").append(node("p", "目前没有足够证据生成馆藏探索结果。", "empty"));
  $("method").replaceChildren(...[profile.method.interpretation, profile.method.scope, profile.method.comparison, profile.method.limitations].map((text) => node("li", text)));
  $("content").hidden = false; $("export").disabled = false;
  $("status").textContent = `读取完成 · ${new Date(profile.generatedAt).toLocaleString("zh-CN")} · 当前索引快照`;
}
async function load() {
  controller?.abort(); const request = new AbortController(); controller = request;
  $("refresh").disabled = true; $("export").disabled = true; $("content").hidden = true;
  $("status").textContent = "正在读取馆藏索引并比较 [A] 样本…"; $("status").classList.remove("error");
  try { const value = await api("/api/fanhao/taste", { signal: request.signal }); if (!request.signal.aborted) render(value); }
  catch (error) { if (!request.signal.aborted) { $("status").textContent = error.message; $("status").classList.add("error"); } }
  finally { if (controller === request) $("refresh").disabled = false; }
}
$("refresh").addEventListener("click", load);
$("sort").addEventListener("change", renderDimension);
$("export").addEventListener("click", () => {
  if (!profile) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `FanHao口味分析-${profile.generatedAt.slice(0, 10)}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("pagehide", () => controller?.abort());
load();
