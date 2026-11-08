import { PHOTO_PERSON_SHELF_CATEGORY } from "./photo-person-shelf.js";

// The favorites shelf mixes regions. These are the Western folders reviewed
// for the naming formats below. Keep the folder keys independent of display names.
const shelfPeople = new Map([
  ["alecia fox pic", "Alecia Fox"], ["ava", "Ava"], ["charlotte.brooke", "Charlotte Brooke"],
  ["dakota pink", "Dakota Pink"], ["daniel sea", "Daniel Sea"], ["elle b", "Elle B"],
  ["emily bloom", "Emily Bloom"], ["faina bona", "Faina Bona"], ["gloria sol", "Gloria Sol"],
  ["jeff milton", "Jeff Milton"], ["kaleesy (foto)", "Kaleesy"], ["marciana (foto)", "Marciana"],
  ["milena d (sunna)_33sets", "Milena D"], ["nimfa", "Nimfa"], ["paloma b", "Paloma B"],
  ["rinna ly", "Rinna Ly"], ["toree ( veronika )", "Toree"], ["veronika.glam", "Veronika Glam"]
]);

const siteAliases = {
  MetArt: ["MA", "Met-Art"], MetArtX: ["MAX"], MetModels: ["Met-Models"],
  RylskyArt: ["RA"], SexArt: ["SA"], AmourAngels: ["AA", "Amour Angels"],
  ShowyBeauty: ["SB"], FemJoy: ["FJ"], MPLStudios: ["MPLS"], Watch4Beauty: ["W4B"],
  iStripper: ["IST"], PlayboyPlus: ["PP"], Domai: ["DM"], EroticBeauty: ["EB", "Erotic Beauty"],
  Nubiles: [], TeenPornStorage: ["TPS"], "Hegre-Art": ["Hegre"],
  "Errotica-Archives": ["Errotica Archives"], GoddessNudes: ["GoddesNudes", "GodessNudes"],
  FedorovHD: ["FHD"], TLE: [], ALn: [], NS: [], EA: [], Eternal: [], EternalDesire: [],
  "21Sextury": [], "X-Art": [], "Naked-Gymnast": [], "Nubiles-Porn": [], "Nude-In-Russia": [],
  "Alex-Lynn": [], ATKHairy: [], AllFineGirls: [], Babes: [], Beauty4K: [], ClubSeventeen: [],
  Cosmid: [], DDFNetwork: [], DeNudeArt: [], Joymii: [], KarupsPC: [], LezCuties: [],
  "MilenaAngel.Club": [], Nakety: [], NubileFilms: [], PhotoDromm: [], Pretty4Ever: [],
  RealityKings: [], SapphicErotica: [], StasyQ: [], Stunning18: [], Sunsetmodelagency: [],
  TeenMegaWorld: [], TheEmilyBloom: [], Ulfthorfotografie: [], UltraFilms: [], WeAreHairy: [], WetAndPuffy: [],
  WowGirls: [], Yonitale: [], Zishy: []
};

const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sites = new Map(Object.entries(siteAliases).flatMap(([site, aliases]) =>
  [site, ...aliases].map(alias => [alias.toLowerCase(), site])));
const siteNames = [...sites.keys()].sort((a, b) => b.length - a.length).map(escapePattern).join("|");
const sitePrefix = new RegExp(`^(?:\\[(${siteNames})(?:\\.(?:com|net))?\\]|(${siteNames})(?:\\.(?:com|net))?(?=$|[\\s._–—-]))`, "iu");
const prefixDate = /^(?:(19\d{2}|20\d{2})|(?<shortYear>\d{2}))(?<separator>[.-]?)(\d{2})\k<separator>(\d{2})(?=$|[\s._\[–—-])/u;
const monthNames = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const nameField = /^[\p{L}][\p{L}.'’ -]*$/u;
const compactName = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function trimSeparators(value) {
  return value.trim().replace(/^[\s._–—-]+|[\s._–—-]+$/gu, "");
}

function readSite(value) {
  const match = sitePrefix.exec(value);
  if (!match) return null;
  const site = sites.get((match[1] || match[2]).toLowerCase());
  const remainder = trimSeparators(value.slice(match[0].length));
  return { site, remainder: site === "Nubiles" ? remainder.replace(/^set\d+\s*[-–—]\s*/iu, "") : remainder };
}

function calendarDate(year, month, day) {
  const date = new Date(Date.UTC(+year, +month - 1, +day));
  return date.getUTCFullYear() === +year && date.getUTCMonth() + 1 === +month && date.getUTCDate() === +day
    ? date.toISOString().slice(0, 10) : "";
}

function readDate(value, allowShortYear) {
  const match = prefixDate.exec(value);
  if (!match || (match.groups.shortYear && !allowShortYear)) return null;
  const date = calendarDate(match[1] || `20${match.groups.shortYear}`, match[4], match[5]);
  return date ? { date, remainder: trimSeparators(value.slice(match[0].length)) } : null;
}

function removeTrailingDate(value, site, shelfPerson) {
  const named = /[\s.-]+([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})(?=$|\s)/iu.exec(value);
  const numeric = /[\s.-]+(\d{1,4})([.-])(\d{2})\2(\d{2}|20\d{2})(?=$|\s)/u.exec(value);
  if (named) {
    const date = calendarDate(named[3], monthNames.indexOf(named[1].toLowerCase()) + 1, named[2]);
    if (date) {
      const suffix = value.slice(named.index + named[0].length).trim();
      const body = value.slice(0, named.index);
      const remainder = compactName(suffix) === compactName(shelfPerson) ? body : `${body} ${suffix}`;
      return { date, remainder: trimSeparators(remainder) };
    }
  }
  if (numeric) {
    const [, first, , second, last] = numeric;
    if (first.length === 4) return { date: calendarDate(first, second, last), remainder: trimSeparators(value.slice(0, numeric.index)) };
    if (last.length === 4) {
      // The same dotted notation is month-first for ATK and day-first in these other releases.
      const dayFirst = +first > 12 || ["Babes", "X-Art"].includes(site);
      const monthFirst = +second > 12 || first === second || site === "ATKHairy";
      const date = dayFirst ? calendarDate(last, second, first) : monthFirst ? calendarDate(last, first, second) : "";
      return { date, remainder: trimSeparators(value.slice(0, numeric.index)) };
    }
  }
  return null;
}

function stripReleaseExtras(value) {
  return value.replace(/[.\s]+XXX[.\s]+IMAGESET(?:[-.][^\s]*)?$/iu, "")
    .replace(/\s+_by\s+.+$/iu, "")
    .replace(/\s+\d{3,5}\s*[x×х]\s*\d{3,5}(?:\s+by\s+.+)?$/iu, "")
    .replace(/\s*[([]\s*[x×х]?\d{1,4}\s*[)\]]?$/iu, "")
    .trim();
}

function personName(value, shelfPerson) {
  const name = value.trim().replace(/\./gu, " ").replace(/\s+/gu, " ");
  const key = compactName(name);
  if (key === compactName(shelfPerson) || key === compactName(shelfPerson.split(" ")[0])) return shelfPerson;
  if (shelfPerson === "Milena D" && key === "sunna") return shelfPerson;
  return name;
}

function readWork(value, shelfPerson, isSceneRelease, compactCredit) {
  if (isSceneRelease) {
    const credits = shelfPerson === "Faina Bona" ? ["Faina Bona And Lena Raz", shelfPerson] : [shelfPerson];
    for (const credit of credits) {
      const prefix = new RegExp(`^${credit.split(" ").map(escapePattern).join("[. ]+")}[. ]+`, "iu");
      if (prefix.test(value)) return { personName: credit.replace(" And ", " & "), albumSubject: value.replace(prefix, "").replace(/\./gu, " ") };
    }
    return null;
  }
  const split = value.match(/^(.+?)\s+[-–—]\s+(.+)$/u)
    || (compactCredit ? value.match(/^([\p{L}]+)-(.+)$/u) : null);
  if (split && split[1].split(/\s*[&,]\s*/u).every(name => nameField.test(name) && name.split(/\s+/u).length <= 6)) {
    return { personName: personName(split[1], shelfPerson), albumSubject: split[2] };
  }
  const avaTitle = shelfPerson === "Ava" && /^Ava\s+([\p{L}]+(?:\.[\p{L}]+)+)$/iu.exec(value);
  return { personName: shelfPerson, albumSubject: avaTitle ? avaTitle[1].replace(/\./gu, " ") : value };
}

export function parseWesternPhotoAlbum(album) {
  if (album?.category !== PHOTO_PERSON_SHELF_CATEGORY) return null;
  const shelfPerson = shelfPeople.get(String(album.subCategory || "").toLowerCase());
  if (!shelfPerson) return null;
  const archiveTitle = String(album.title || "").trim();
  const leadingSite = readSite(archiveTitle);
  const text = leadingSite?.remainder ?? archiveTitle;
  const leadingDate = readDate(text, Boolean(leadingSite));
  const afterDate = leadingDate?.remainder ?? text;
  const innerSite = leadingDate && !leadingSite ? readSite(afterDate) : null;
  const parent = String(album.relativePath || "").split(/[\\/]/u).at(-2) || "";
  const folderSite = readSite(parent)?.site || "";
  const photoSite = leadingSite?.site || innerSite?.site || folderSite;
  if (!photoSite && !leadingDate) return null;

  const work = innerSite?.remainder ?? afterDate;
  const isSceneRelease = /[.\s]+XXX[.\s]+IMAGESET\b/iu.test(work);
  const stripped = trimSeparators(stripReleaseExtras(work));
  const trailing = leadingDate ? null : removeTrailingDate(stripped, photoSite, shelfPerson);
  const archiveDate = leadingDate?.date || trailing?.date || "";
  const body = trailing?.remainder ?? stripped;
  const numberedSet = /^(Kate|Katya) ((?:Set|Serie) \d+)$/u.exec(body);
  const eternalTitle = photoSite === "Eternal" && shelfPerson === "Emily Bloom" && /^(.+)-Emily-Bloom-by-.+$/iu.exec(body);
  const credit = numberedSet ? { personName: numberedSet[1], albumSubject: numberedSet[2] }
    : eternalTitle ? { personName: shelfPerson, albumSubject: eternalTitle[1].replace(/-/gu, " ") }
      : readWork(body, shelfPerson, isSceneRelease, /^(?:daniel sea|kaleesy \(foto\))$/iu.test(album.subCategory));
  if (!credit?.albumSubject) return null;
  return { ...credit, archiveTitle, archiveDate, photoSite, photoRegion: "western" };
}
