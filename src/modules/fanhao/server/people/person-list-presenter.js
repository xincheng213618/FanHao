export function publicPersonListItem(person) {
  if (!person) return null;
  const profile = person.actorProfile || null;
  return {
    id: person.id,
    name: person.name,
    relativePath: person.relativePath || "",
    sourceCount: Number(person.sourceCount || 0),
    workCount: Number(person.workCount || 0),
    avatarUrl: person.avatarUrl || (person.coverId ? `/media/person/${encodeURIComponent(String(person.id || ""))}/cover` : ""),
    actorProfile: profile
      ? {
          personName: profile.personName || "",
          displayName: profile.displayName || "",
          aliases: Array.isArray(profile.aliases) ? profile.aliases : [],
          gender: profile.gender || "unknown"
        }
      : null
  };
}
