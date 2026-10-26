import { workCodeKey } from "../../../../../lib/code-parser.js";

export const TASTE_DIMENSIONS = Object.freeze([
  { key: "people", label: "收藏人物", weight: 0.4 },
  { key: "tags", label: "标签", weight: 0.3 },
  { key: "makers", label: "厂牌", weight: 0.15 },
  { key: "series", label: "系列", weight: 0.1 },
  { key: "prefixes", label: "番号前缀", weight: 0.05 }
]);

const round = (value, places = 4) => Number(value.toFixed(places));
const clean = (value) => String(value || "").normalize("NFKC").trim();

export function buildTasteProfile(input, { now = new Date().toISOString(), limit = 20 } = {}) {
  // One release contributes once, even when it has several files or editions.
  const grouped = new Map();
  for (const row of input) {
    const code = clean(row.code);
    const identity = workCodeKey(code) || `id:${row.id}`;
    let item = grouped.get(identity);
    if (!item) {
      item = { id: String(row.id), code, title: clean(row.title), marked: false,
        features: Object.fromEntries(TASTE_DIMENSIONS.map(({ key }) => [key, new Map()])) };
      grouped.set(identity, item);
    }
    item.marked ||= row.marked === true;
    for (const { key } of TASTE_DIMENSIONS) {
      for (const feature of row[key] || []) {
        const name = clean(typeof feature === "string" ? feature : feature.name);
        if (name) item.features[key].set(String(feature.id ?? name.toLocaleLowerCase()), name);
      }
    }
  }
  const works = [...grouped.values()];
  const marked = works.filter((work) => work.marked);
  const featureScores = new Map();
  const dimensions = TASTE_DIMENSIONS.map(({ key, label }) => {
    const known = works.filter((work) => work.features[key].size);
    const markedKnown = known.filter((work) => work.marked);
    const baselineRate = known.length ? markedKnown.length / known.length : 0;
    const counts = new Map();
    for (const work of known) for (const [id, name] of work.features[key]) {
      let feature = counts.get(id);
      if (!feature) { feature = { id, name, total: 0, marked: 0, examples: [] }; counts.set(id, feature); }
      feature.total++;
      if (work.marked) {
        feature.marked++;
        if (feature.examples.length < 3) feature.examples.push({ code: work.code, id: work.id });
      }
    }
    const rows = [...counts.values()].map((feature) => {
      const markedRate = feature.marked / feature.total;
      // Twenty baseline observations keep a tiny sample from dominating.
      const adjustedRate = (feature.marked + 20 * baselineRate) / (feature.total + 20);
      const lift = baselineRate ? markedRate / baselineRate : 0;
      const adjustedLift = baselineRate ? adjustedRate / baselineRate : 0;
      const score = feature.marked >= 3 && feature.total >= 5 && markedKnown.length >= 5
        ? Math.max(0, Math.log2(adjustedLift)) * Math.log2(1 + feature.marked) : 0;
      featureScores.set(`${key}:${feature.id}`, { score, name: feature.name, marked: feature.marked });
      return { ...feature, markedRate: round(markedRate), lift: round(lift), adjustedLift: round(adjustedLift),
        collectionShare: round(feature.total / known.length),
        markedShare: markedKnown.length ? round(feature.marked / markedKnown.length) : 0,
        score: round(score), support: feature.marked >= 5 && feature.total >= 10 ? "repeated" : "limited" };
    });
    return { key, label, known: known.length, markedKnown: markedKnown.length,
      coverage: works.length ? round(known.length / works.length) : 0,
      markedCoverage: marked.length ? round(markedKnown.length / marked.length) : 0,
      baselineRate: round(baselineRate), featureCount: rows.length,
      distinctive: rows.filter((row) => row.score > 0).sort((a, b) => b.score - a.score || b.marked - a.marked || a.name.localeCompare(b.name)).slice(0, limit),
      favorites: rows.filter((row) => row.marked).sort((a, b) => b.marked - a.marked || b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit) };
  });
  const recommendations = [];
  for (const work of works) {
    if (work.marked) continue;
    let score = 0;
    const reasons = [];
    for (const dimension of TASTE_DIMENSIONS) {
      const matching = [...work.features[dimension.key].keys()]
        .map((id) => featureScores.get(`${dimension.key}:${id}`)).filter((item) => item?.score > 0)
        .sort((a, b) => b.score - a.score);
      if (matching.length) {
        score += dimension.weight * matching[0].score;
        reasons.push({ dimension: dimension.label, name: matching[0].name, marked: matching[0].marked });
      }
    }
    if (score) recommendations.push({ id: work.id, code: work.code, title: work.title, score: round(score), reasons });
  }
  recommendations.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  return { version: 1, generatedAt: now, summary: { total: works.length, marked: marked.length,
    markedRate: works.length ? round(marked.length / works.length) : 0,
    indexedRows: input.length, duplicateRows: input.length - works.length }, dimensions,
    recommendations: recommendations.slice(0, 24),
    method: { marker: "[A]", minimumMarked: 3, priorSamples: 20,
      scope: "已登记且含本地视频的作品，按番号去重；人物按收藏目录归属统计，番号前缀与作品系列分开。不检查磁盘上的当前可用性。",
      interpretation: "[A] 是特别喜欢；其他馆藏是基础偏好，未标记不代表不喜欢。",
      comparison: "各维度只比较有该类资料的作品；倾向倍数按该维度的整体标记率计算，并用 20 个基础样本平滑。",
      limitations: "资料缺失、标记习惯和人物与标签的共现会影响结果；分数是匹配排序，不是喜欢概率。" } };
}
