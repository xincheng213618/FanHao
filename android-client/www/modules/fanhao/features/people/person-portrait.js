import { portraitUrlForPerson } from "../../../../js/image.js?v=assets-0f97d6765d71";

export function mergePersonIdentity(indexedPerson, detailPerson) {
  const indexed = indexedPerson && typeof indexedPerson === "object" ? indexedPerson : null;
  const detail = detailPerson && typeof detailPerson === "object" ? detailPerson : null;
  const merged = { ...(indexed || {}), ...(detail || {}) };
  const portraitOwner = [detail, indexed].find((person) => portraitUrlForPerson(person)) || null;

  return {
    ...merged,
    actorProfile: detail?.actorProfile || indexed?.actorProfile || null,
    avatarUrl: portraitOwner ? portraitUrlForPerson(portraitOwner) : "",
    avatarImage: portraitOwner?.avatarImage || null
  };
}
