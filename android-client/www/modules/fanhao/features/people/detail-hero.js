import { formatNumber } from "../../../../js/format.js";
import { absoluteUrl, createFallbackCover, imageUrlForPerson, loadPreviewImage } from "../../../../js/image.js?v=20260717-fanhao-cover-prepare-01";

export function createPersonDetailHero(person, options = {}) {
  const activeUrl = options.activeUrl || "";
  const hero = document.createElement("div");
  hero.className = "detail-hero person-detail-hero";

  const visualFrame = document.createElement("div");
  visualFrame.className = "person-detail-avatar-frame";
  const visual = createFallbackCover(person.name);
  visualFrame.append(visual);
  hero.append(visualFrame);
  const imagePath = imageUrlForPerson(person);
  const imageUrl = absoluteUrl(activeUrl, imagePath);
  if (imagePath) {
    loadPreviewImage(visual, imageUrl, {
      cacheBaseUrl: activeUrl,
      decorate: (img) => options.mediaViewer?.bindImageTrigger(img, img.src, person.actorProfile?.displayName || person.name)
    });
  }

  const body = document.createElement("div");
  body.className = "detail-hero-body";
  const eyebrow = document.createElement("span");
  eyebrow.className = "person-detail-eyebrow";
  eyebrow.textContent = "作者";
  const name = document.createElement("strong");
  name.className = "person-detail-name";
  name.textContent = person.actorProfile?.displayName || person.name;
  const aliases = personAliasText(person);
  const alias = document.createElement("span");
  alias.className = "person-detail-alias";
  alias.textContent = aliases ? `又名 ${aliases}` : "";
  alias.hidden = !aliases;
  const workCount = document.createElement("div");
  workCount.className = "person-detail-work-count";
  const workCountValue = document.createElement("strong");
  workCountValue.textContent = formatNumber(person.workCount);
  const workCountUnit = document.createElement("span");
  workCountUnit.textContent = "部作品";
  workCount.append(workCountValue, workCountUnit);
  const facts = createPersonFacts(person, options.cacheNote);
  const sources = createPersonSourceStrip(person);
  body.append(eyebrow, name, alias, workCount);
  if (facts) body.append(facts);
  if (sources) body.append(sources);
  hero.append(body);
  return hero;
}

function personAliasText(person) {
  const displayName = String(person.actorProfile?.displayName || person.name || "").trim();
  const candidates = [person.name, ...(person.actorProfile?.aliases || [])];
  const seen = new Set([displayName.toLocaleLowerCase()]);
  const aliases = [];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key) || /^codex(?:smoke)?alias(?:[_-]|\d|$)/iu.test(value)) continue;
    seen.add(key);
    aliases.push(value);
    if (aliases.length >= 3) break;
  }
  return aliases.join(" · ");
}

function createPersonFacts(person, cacheNote = "") {
  const labels = [];
  if (Number(person.videoCount || 0) > 0) labels.push(`${formatNumber(person.videoCount)} 个视频`);
  if (Number(person.infoCount || 0) > 0) labels.push(`${formatNumber(person.infoCount)} 份资料`);
  if (Number(person.sourceCount || 0) > 1) labels.push(`${formatNumber(person.sourceCount)} 个来源`);
  if (cacheNote) labels.push(cacheNote);
  if (!labels.length) return null;
  const facts = document.createElement("div");
  facts.className = "person-detail-facts";
  for (const label of labels) {
    const fact = document.createElement("span");
    fact.textContent = label;
    facts.append(fact);
  }
  return facts;
}

function createPersonSourceStrip(person) {
  const labels = personSourceLabels(person);
  if (!labels.length) return null;
  const strip = document.createElement("div");
  strip.className = "person-source-strip";
  for (const label of labels) {
    const chip = document.createElement("span");
    chip.className = "person-source-chip";
    chip.textContent = label;
    strip.append(chip);
  }
  return strip;
}

function personSourceLabels(person) {
  const paths = [...(person.sourcePaths || []), person.relativePath].filter(Boolean);
  const labels = new Set();
  for (const sourcePath of paths) {
    const source = normalizePersonSource(sourcePath);
    if (source) labels.add(source);
  }
  return [...labels];
}

function normalizePersonSource(sourcePath) {
  const value = String(sourcePath || "").replace(/\\/g, "/").toLowerCase();
  if (!value) return "";
  if (value.startsWith("v:/")) return "VR";
  if (value.startsWith("o:/[珍藏1]")) return "珍藏1";
  if (value.startsWith("o:/[珍藏]")) return "珍藏";
  if (value.startsWith("g:/") || value.startsWith("f:/") || value.startsWith("o:/")) return "普通";
  if (value.startsWith("r:/")) return "欧美";
  return "";
}
