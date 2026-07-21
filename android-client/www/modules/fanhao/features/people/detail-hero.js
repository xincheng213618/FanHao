import { formatNumber } from "../../../../js/format.js";
import { absoluteUrl, createFallbackCover, loadPreviewImage, portraitUrlForPerson } from "../../../../js/image.js?v=20260721-fanhao-search-suggestions-19";

export function createPersonDetailHero(person, options = {}) {
  const activeUrl = options.activeUrl || "";
  const hero = document.createElement("div");
  hero.className = "detail-hero person-detail-hero";

  const visualFrame = document.createElement("div");
  visualFrame.className = "person-detail-avatar-frame";
  const visual = createFallbackCover(person.name);
  visualFrame.append(visual);
  hero.append(visualFrame);
  const imagePath = portraitUrlForPerson(person);
  const imageUrl = absoluteUrl(activeUrl, imagePath);
  if (imagePath) {
    loadPreviewImage(visual, imageUrl, {
      cacheBaseUrl: activeUrl,
      decorate: (img) => options.mediaViewer?.bindImageTrigger(img, img.src, person.actorProfile?.displayName || person.name)
    });
  }

  const body = document.createElement("div");
  body.className = "detail-hero-body";
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
  const filmographyCount = finiteCount(options.filmographyCount);
  const workCountPrefix = document.createElement("span");
  workCountPrefix.textContent = filmographyCount === null ? "本地收录" : "出演过";
  const workCountValue = document.createElement("strong");
  workCountValue.textContent = formatNumber(filmographyCount ?? person.workCount);
  const workCountUnit = document.createElement("span");
  workCountUnit.textContent = filmographyCount === null ? "部作品" : "部影片";
  workCount.append(workCountPrefix, workCountValue, workCountUnit);
  const categories = createPersonCategoryStrip(options.categories);
  body.append(name, alias, workCount);
  if (categories) body.append(categories);
  hero.append(body);
  return hero;
}

function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
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

function createPersonCategoryStrip(categories = []) {
  const items = (Array.isArray(categories) ? categories : [])
    .map((category) => ({
      count: finiteCount(category?.count),
      label: String(category?.label || "").trim(),
      value: String(category?.value || "").trim()
    }))
    .filter((category) => category.label && category.count > 0);
  if (!items.length) return null;
  const strip = document.createElement("div");
  strip.className = "person-category-strip";
  strip.setAttribute("aria-label", "作品分类");
  for (const category of items) {
    const chip = document.createElement("span");
    chip.className = "person-category-chip";
    if (category.value) chip.dataset.category = category.value;
    chip.textContent = `${category.label} ${formatNumber(category.count)}`;
    strip.append(chip);
  }
  return strip;
}
