function cleanNicknameCandidate(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 32) return "";
  if (/captcha|\.zip$|\.rar$|\.7z$|搜索|推荐|关注|粉丝|获赞|作品/i.test(name)) return "";
  return name;
}

function nicknameFromPageTitle(value) {
  const title = String(value || "").trim();
  const match =
    title.match(/^(.+?)的抖音(?:\s*-\s*抖音)?$/u) ||
    title.match(/^(.+?)\s*-\s*抖音$/u);
  return cleanNicknameCandidate(match?.[1]);
}

export function profileNicknameFromSnapshot(snapshot = {}) {
  const text = String(snapshot.text || "");
  const counterPredecessor = (
    text.match(/(?:^|\n)\s*([^\n]{1,32})\s*\n\s*关注\s*[0-9.,万亿wk]/i) || []
  )[1];
  return (
    cleanNicknameCandidate(snapshot.heading) ||
    nicknameFromPageTitle(snapshot.title) ||
    cleanNicknameCandidate(counterPredecessor)
  );
}
