export const PHOTO_PERSON_SHELF_CATEGORY = "我喜欢的";

export function photoPersonShelfName(album) {
  if (album?.category !== PHOTO_PERSON_SHELF_CATEGORY) return "";
  const folder = String(album.subCategory || "").trim();
  const name = folder
    .replace(/[_\s-]+\d+\s*sets?$/iu, "")
    .replace(/\s+[(（][^()（）]+[)）]$/u, "")
    .trim();
  return /^[a-z]+(?:[ '\u2019-]+[a-z]+)+$/.test(name)
    ? name.replace(/(^|[ '\u2019-])([a-z])/g, (_, separator, initial) => separator + initial.toUpperCase())
    : name;
}
