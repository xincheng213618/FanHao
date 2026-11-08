export const BOBO_SOCKS_CATEGORY = "[BoBoSocks袜啵啵]";

const albumPrefix = /^[\[［]BoBoSocks袜啵啵[\]］]\s*N[O0][.．]?\s*([0-9０-９]{1,5})(?![0-9０-９])\s*/iu;
const statsSuffix = /\s*[\[［【(（]([^\]］】)）]*)[\]］】)）]\s*$/u;
const multiplePeople = new Map([
  ["小甜豆稚予", ["小甜豆", "稚予"]],
  ["小甜豆与稚予", ["小甜豆", "稚予"]],
  ["小甜豆小安", ["小甜豆", "小安"]],
  ["果果橘橘", ["果果", "橘橘"]]
]);

export function parseBoBoSocksAlbum(value) {
  if (typeof value !== "string") return null;
  const title = value.trimStart();
  const prefix = title.match(albumPrefix);
  if (!prefix) return null;
  const body = title.slice(prefix[0].length).replace(statsSuffix, (suffix, contents) =>
    /(?:\d+\s*[PV]\b|(?:MB|GB)\b)/iu.test(contents.normalize("NFKC")) ? "" : suffix).trim();
  if (!body) return null;
  const split = body.match(/^([\p{L}·]{1,16})\s*[-–—－]\s*(\S.*)$/u);
  const photoPeople = split ? [...(multiplePeople.get(split[1]) || [split[1]])] : [];
  return {
    albumNumber: `NO.${prefix[1].normalize("NFKC")}`,
    albumSubject: split?.[2] || body,
    personName: photoPeople.join("、"),
    photoPeople
  };
}
