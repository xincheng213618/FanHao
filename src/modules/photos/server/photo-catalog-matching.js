const mediaCount = String.raw`\d{1,7}(?:\s*\+\s*\d{1,7})*\s*(?:P|V|张|段|部)`;
const mediaSize = String.raw`\d{1,7}(?:\.\d{1,4})?\s*[KMGT](?:I?B)?`;
const mediaFact = `(?:${mediaCount}|${mediaSize})`;
const mediaFacts = new RegExp(String.raw`^\s*${mediaFact}(?:(?:\s*[-+/、,]\s*|\s+)?${mediaFact})*\s*$`, "iu");

function normalized(value) {
  return String(value || "").normalize("NFKC").replace(/[‐‑‒–—]/gu, "-").trim();
}

function titleKey(value) {
  const title = normalized(value);
  const stats = /\[([^\[\]]+)\]$|\(([^()]+)\)$|【([^【】]+)】$/u.exec(title);
  const facts = stats && (stats[1] ?? stats[2] ?? stats[3]);
  const name = facts && mediaFacts.test(facts) ? title.slice(0, stats.index) : title;
  return name.trim().toLowerCase().replace(/\s+/gu, " ");
}

function searchKey(value) {
  const text = normalized(value).toLowerCase();
  return text.replace(/[\s\p{P}]/gu, character => character === "-" ? character : "") || text;
}

function numberParts(main, part) {
  return { main: Number(main), part: part == null ? null : Number(part) };
}

function markedIssue(value) {
  const text = normalized(value);
  const labeled = /(?:^|[^a-z0-9])(VOL|N[O0])[.\s_#-]*(\d{1,8})(?:-(\d{1,4}))?(?!\d|-\d)(?=$|[^a-z0-9])/iu.exec(text);
  if (labeled) {
    const [, label, main, part] = labeled;
    const prefix = /^vol$/iu.test(label) ? "vol" : "no";
    return { ...numberParts(main, part), prefix, code: `${prefix.toUpperCase()}.${main}${part ? `-${part}` : ""}` };
  }
  const chinese = /第\s*(\d{1,8})(?:-(\d{1,4}))?\s*期/u.exec(text);
  return chinese ? { ...numberParts(chinese[1], chinese[2]), prefix: "期", code: chinese[0].replace(/\s+/g, "") } : null;
}

export function photoIssueCode(title) {
  return markedIssue(title)?.code || "";
}

function issueBadge(value) {
  const badge = /^(\d{1,8})(?:-(\d{1,4}))?$/u.exec(normalized(value));
  return badge ? numberParts(badge[1], badge[2]) : null;
}

function legacySequence(value) {
  const sequence = /^(\d{1,4})(?:-(\d{1,4}))?\.(?!\s*\d)/u.exec(normalized(value));
  return sequence ? numberParts(sequence[1], sequence[2]) : null;
}

function preferredIssue(entry) {
  const issue = markedIssue(entry?.issueCode) || markedIssue(entry?.title);
  const badge = issueBadge(entry?.issueLabel) || issueBadge(entry?.issueCode);
  if (!issue) return badge;
  if (issue.part == null && badge?.main === issue.main && badge.part != null) return { ...issue, part: badge.part };
  return issue;
}

function sameIssue(left, right) {
  return left && right && left.main === right.main && left.part === right.part;
}

export function rankPhotoArchiveCandidates(entry, albums, { limit = 12, query = "" } = {}) {
  const cap = Number.isSafeInteger(limit) && limit >= 0 ? limit : 12;
  const search = searchKey(query);
  if (search) {
    const matches = albums.filter(album => searchKey(album.title).includes(search));
    return { albums: matches.slice(0, cap), total: matches.length };
  }

  const title = titleKey(entry?.title);
  const issue = preferredIssue(entry);
  const exactTitle = [], exactIssue = [], relatedIssue = [];
  for (const album of albums) {
    if (title && titleKey(album.title) === title) {
      exactTitle.push(album);
    } else if (issue) {
      const label = markedIssue(album.title);
      if (sameIssue(issue, label) && issue.prefix && issue.prefix === label.prefix) exactIssue.push(album);
      else if (sameIssue(issue, label || legacySequence(album.title))) relatedIssue.push(album);
    }
  }
  const matches = [...exactTitle, ...exactIssue, ...relatedIssue];
  const candidates = matches.length ? matches : albums.length <= cap ? albums : [];
  return { albums: candidates.slice(0, cap), total: candidates.length };
}
