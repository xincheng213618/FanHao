export function publicPersonListItem(person) {
  if (!person) return null;
  const profile = person.actorProfile || null;
  return {
    id: person.id,
    name: person.name,
    relativePath: person.relativePath || "",
    sourceCount: Number(person.sourceCount || 0),
    workCount: Number(person.workCount || 0),
    videoCount: Number(person.videoCount || 0),
    playableCount: Number(person.playableCount || 0),
    imageCount: Number(person.imageCount || 0),
    infoCount: Number(person.infoCount || 0),
    isGSource: Boolean(person.isGSource),
    avatarUrl: person.avatarUrl || (person.coverId ? `/media/person/${encodeURIComponent(String(person.id || ""))}/cover` : ""),
    actorProfile: profile
      ? {
          personName: profile.personName || "",
          displayName: profile.displayName || "",
          aliases: Array.isArray(profile.aliases) ? profile.aliases : [],
          gender: profile.gender || "unknown",
          movieCount: Number(profile.movieCount || 0),
          javdbUrl: profile.javdbUrl || ""
        }
      : null
  };
}
