function normalizedText(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase();
}

function normalizedPath(value) {
  return String(value || "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLocaleLowerCase();
}

function pathStartsWithRoot(value, root) {
  const target = normalizedPath(value);
  const prefix = normalizedPath(root);
  return Boolean(target && prefix && (target === prefix || target.startsWith(`${prefix}/`)));
}

export function isVrWorkForMove(work) {
  const text = `${work?.relativePath || ""}\n${work?.title || ""}\n${work?.directoryName || ""}`.toLocaleLowerCase();
  return text.includes("v:/") || text.includes("[vr]") || /\bvr\b/i.test(text);
}

export function isVrLibraryPath(value) {
  const text = normalizedPath(value);
  return text.startsWith("v:") || text.includes("[vr]") || /(?:^|[\/\s._-])vr(?:$|[\/\s._-])/.test(text);
}

export function personMoveDisplayName(person) {
  const storedName = String(person?.name || "").trim();
  if (/(?:^|[\s._-])vr$/i.test(storedName)) return storedName;
  return String(person?.actorProfile?.displayName || storedName || person?.actorProfile?.personName || "").trim();
}

export function personMoveSearchValues(person) {
  const profile = person?.actorProfile || {};
  return [
    person?.id,
    person?.name,
    profile.personName,
    profile.displayName,
    ...(Array.isArray(profile.aliases) ? profile.aliases : [])
  ].map(normalizedText).filter(Boolean);
}

export function personMoveSourcePaths(person) {
  const paths = [person?.relativePath, ...(Array.isArray(person?.sourcePaths) ? person.sourcePaths : [])];
  const seen = new Set();
  return paths.filter((value) => {
    const key = normalizedPath(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function existingVrPersonPath(person) {
  return personMoveSourcePaths(person).find(isVrLibraryPath) || "";
}

export function workMoveSourceRoot(work, roots = []) {
  const sourcePath = work?.relativePath || work?.videos?.[0]?.relativePath || "";
  return [...(Array.isArray(roots) ? roots : [])]
    .filter((root) => pathStartsWithRoot(sourcePath, root))
    .sort((left, right) => normalizedPath(right).length - normalizedPath(left).length)[0] || "";
}

export function planWorkMoveTarget({ work, selectedPerson, people = [], roots = [], defaultRoot = "" } = {}) {
  if (!selectedPerson?.id) return null;
  if (!isVrWorkForMove(work)) {
    return {
      mode: "existing",
      personId: String(selectedPerson.id),
      person: selectedPerson,
      sourcePerson: selectedPerson,
      adjustedForVr: false
    };
  }

  const vrPath = existingVrPersonPath(selectedPerson);
  return {
    mode: "existing",
    personId: String(selectedPerson.id),
    person: vrPath
      ? { ...selectedPerson, relativePath: vrPath, sourcePaths: [vrPath, ...personMoveSourcePaths(selectedPerson).filter((path) => normalizedPath(path) !== normalizedPath(vrPath))] }
      : selectedPerson,
    targetDirectory: vrPath,
    sourcePerson: selectedPerson,
    adjustedForVr: Boolean(vrPath && normalizedPath(vrPath) !== normalizedPath(selectedPerson.relativePath)),
    unavailableReason: vrPath ? "" : "这个人物没有已存在的 VR 目录"
  };
}
